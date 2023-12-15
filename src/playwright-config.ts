import type { Request as MirageRequest } from "miragejs";
import type {
  HTTPVerb,
  RouteHandler,
  ServerConfig as MirageServerConfig,
} from "miragejs/server";
import type { AnyFactories, AnyModels, AnyRegistry } from "miragejs/-types";
import type {
  Page,
  Route,
  Request as PlaywrightRequest,
} from "@playwright/test";
import RouteRecognizer from "route-recognizer";

type RawHandler = RouteHandler<AnyRegistry> | {};

type ResponseCode = number;

/** e.g. "/movies/:id" */
type Shorthand = string;

type RouteArgs =
  | [RouteOptions]
  | [Record<string, unknown>, ResponseCode]
  | [Function, ResponseCode]
  | [Shorthand, RouteOptions]
  | [Shorthand, ResponseCode, RouteOptions];

type RouteArguments = [
  RawHandler | undefined,
  ResponseCode | undefined,
  RouteOptions
];

type BaseHandler = (path: string, ...args: RouteArgs) => void;

interface ServerConfig<Models extends AnyModels, Factories extends AnyFactories>
  extends MirageServerConfig<Models, Factories> {
  page: Page;
  interceptUrlPattern?: string;
}

type MirageRouteHandlerResponse = [
  number,
  Record<string, string> | undefined,
  string | {} | undefined
];

type MirageServer = {
  registerRouteHandler: (
    verb: HTTPVerb,
    path: string,
    rawHandler?: RawHandler,
    customizedCode?: ResponseCode,
    options?: unknown
  ) => (
    request: MirageRequest
  ) => MirageRouteHandlerResponse | PromiseLike<MirageRouteHandlerResponse>;

  shouldLog: () => boolean;

  get?: BaseHandler;
  post?: BaseHandler;
  put?: BaseHandler;
  delete?: BaseHandler;
  del?: BaseHandler;
  patch?: BaseHandler;
  head?: BaseHandler;
  options?: BaseHandler;
};

type RouteOptions = {
  /** JSON-api option */
  coalesce?: boolean;
  /**
   * Pretender treats a boolean timing option as "async", number as ms delay.
   * TODO: Not sure what MSW does yet.
   */
  timing?: boolean | number;
};

const defaultRouteOptions = {
  coalesce: false,
  timing: undefined,
};

/**
 * Determine if the object contains a valid option.
 *
 * @method isOption
 * @param {Object} option An object with one option value pair.
 * @return {Boolean} True if option is a valid option, false otherwise.
 * @private
 */
function isOption(option: unknown): option is RouteOptions {
  if (!option || typeof option !== "object") {
    return false;
  }

  let allOptions = Object.keys(defaultRouteOptions);
  let optionKeys = Object.keys(option);
  for (let i = 0; i < optionKeys.length; i++) {
    let key = optionKeys[i];
    if (allOptions.indexOf(key) > -1) {
      return true;
    }
  }
  return false;
}

/**
 * Extract arguments for a route.
 *
 * @method extractRouteArguments
 * @param {Array} args Of the form [options], [object, code], [function, code]
 * [shorthand, options], [shorthand, code, options]
 * @return {Array} [handler (i.e. the function, object or shorthand), code,
 * options].
 */
function extractRouteArguments(args: RouteArgs): RouteArguments {
  let result: RouteArguments = [undefined, undefined, {}];

  for (const arg of args) {
    if (isOption(arg)) {
      result[2] = { ...defaultRouteOptions, ...arg };
    } else if (typeof arg === "number") {
      result[1] = arg;
    } else {
      result[0] = arg;
    }
  }
  return result;
}

export default class PlaywrightConfig {
  urlPrefix?: string;
  namespace?: string;
  timing?: number;
  interceptUrlPattern = "**";
  page?: Page;
  mirageServer?: MirageServer;
  mirageConfig?: ServerConfig<AnyModels, AnyFactories>;

  private router: Record<string, RouteRecognizer> = {};
  private playwrightHandler?: (route: Route, request: PlaywrightRequest) => any;
  private playwrightPassthroughHandler = (
    route: Route,
    _request: PlaywrightRequest
  ) => {
    let request = route.request();
    let verb = request.method();
    let url = request.url();
    if (this.mirageServer?.shouldLog()) {
      console.log(
        `Mirage: Passthrough request for ${verb.toUpperCase()} ${url}`
      );
    }
    route.continue();
  };

  private passthroughChecks: ((req: PlaywrightRequest) => boolean)[] = [];

  get?: BaseHandler;
  post?: BaseHandler;
  put?: BaseHandler;
  delete?: BaseHandler;
  del?: BaseHandler;
  patch?: BaseHandler;
  head?: BaseHandler;
  options?: BaseHandler;

  create(
    mirageServer: MirageServer,
    config: ServerConfig<AnyModels, AnyFactories>
  ) {
    this.mirageServer = mirageServer;

    this.interceptUrlPattern =
      config.interceptUrlPattern ?? this.interceptUrlPattern;
    this.page = config.page;
    if (!this.page) {
      throw new Error("A Playwright Page must be passed in the mirageConfig");
    }

    this.config(config);

    const verbs = [
      ["get"] as const,
      ["post"] as const,
      ["put"] as const,
      ["delete", "del"] as const,
      ["patch"] as const,
      ["head"] as const,
      ["options"] as const,
    ];

    verbs.forEach(([verb, alias]) => {
      this.router[verb] = new RouteRecognizer();
      this[verb] = (path: string, ...args: RouteArgs) => {
        let [rawHandler, customizedCode, options] = extractRouteArguments(args);

        // This assertion is for TypeScript, we don't expect it to happen
        if (!this.mirageServer) {
          throw new Error("Lost the mirageServer");
        }

        let handler = this.mirageServer.registerRouteHandler(
          verb,
          path,
          rawHandler,
          customizedCode,
          options
        );

        let fullPath = this._getFullPath(path);
        this.router[verb].add([{ path: fullPath, handler }]);
      };
      mirageServer[verb] = this[verb];

      if (alias) {
        this[alias] = this[verb];
        mirageServer[alias] = this[verb];
      }
    });

    this.playwrightHandler = async (
      route: Route,
      _request: PlaywrightRequest
    ) => {
      const request = route.request();
      const method = request.method();
      const url = new URL(request.url());
      const requestHeaders = await request.allHeaders();
      const postData = request.postData();

      let handler;
      let params = {};
      let queryParams = {};
      let matches = this.router[method.toLowerCase()]?.recognize(url.pathname);

      let match = matches ? matches[0] : null;
      if (match) {
        handler = match.handler;
        params = match.params;
        queryParams = matches!.queryParams;
      } else {
        throw new Error(`No Mirage route registered for ${url.pathname}`);
      }

      if (handler === this.playwrightPassthroughHandler) {
        return this.playwrightPassthroughHandler(route, _request);
      }

      let mirageRequest: MirageRequest = {
        requestBody: postData ?? "",
        requestHeaders,
        url: url.pathname,
        params,
        queryParams,
      };

      // @ts-ignore
      let [status, headers, body] = await handler(mirageRequest);

      if (this.mirageServer?.shouldLog()) {
        console.log(`Mirage: [${status}] ${method.toUpperCase()} ${url}`);
      }

      // TODO: add timing support (e.g. longer delay before response)
      await route.fulfill({
        status,
        headers,
        body: body as string, // TODO: ideally get rid of this cast, we should figure out if there is any chance it'd return {}
      });
    };

    this.page!.route(this.interceptUrlPattern, this.playwrightHandler);
  }

  // TODO: infer models and factories
  config(mirageConfig: ServerConfig<AnyModels, AnyFactories>) {
    /**
         Sets a string to prefix all route handler URLs with.

         Useful if your app makes API requests to a different port.

         ```js
         createServer({
         routes() {
         this.urlPrefix = 'http://localhost:8080'
         }
         })
         ```
         */
    this.urlPrefix = this.urlPrefix || mirageConfig.urlPrefix || "";

    /**
         Set the base namespace used for all routes defined with `get`, `post`, `put` or `del`.

         For example,

         ```js
         createServer({
         routes() {
         this.namespace = '/api';

         // this route will handle the URL '/api/contacts'
         this.get('/contacts', 'contacts');
         }
         })
         ```

         Note that only routes defined after `this.namespace` are affected. This is useful if you have a few one-off routes that you don't want under your namespace:

         ```js
         createServer({
         routes() {

         // this route handles /auth
         this.get('/auth', function() { ...});

         this.namespace = '/api';
         // this route will handle the URL '/api/contacts'
         this.get('/contacts', 'contacts');
         };
         })
         ```

         If your app is loaded from the filesystem vs. a server (e.g. via Cordova or Electron vs. `localhost` or `https://yourhost.com/`), you will need to explicitly define a namespace. Likely values are `/` (if requests are made with relative paths) or `https://yourhost.com/api/...` (if requests are made to a defined server).

         For a sample implementation leveraging a configured API host & namespace, check out [this issue comment](https://github.com/miragejs/ember-cli-mirage/issues/497#issuecomment-183458721).

         @property namespace
         @type String
         @public
         */
    this.namespace = this.namespace || mirageConfig.namespace || "";
  }

  /**
   * Builds a full path for Pretender to monitor based on the `path` and
   * configured options (`urlPrefix` and `namespace`).
   *
   * @private
   * @hide
   */
  _getFullPath(path: string) {
    path = path[0] === "/" ? path.slice(1) : path;
    let fullPath = "";
    let urlPrefix = this.urlPrefix ? this.urlPrefix.trim() : "";
    let namespace = "";

    // if there is a urlPrefix and a namespace
    if (this.urlPrefix && this.namespace) {
      if (
        this.namespace[0] === "/" &&
        this.namespace[this.namespace.length - 1] === "/"
      ) {
        namespace = this.namespace
          .substring(0, this.namespace.length - 1)
          .substring(1);
      }

      if (
        this.namespace[0] === "/" &&
        this.namespace[this.namespace.length - 1] !== "/"
      ) {
        namespace = this.namespace.substring(1);
      }

      if (
        this.namespace[0] !== "/" &&
        this.namespace[this.namespace.length - 1] === "/"
      ) {
        namespace = this.namespace.substring(0, this.namespace.length - 1);
      }

      if (
        this.namespace[0] !== "/" &&
        this.namespace[this.namespace.length - 1] !== "/"
      ) {
        namespace = this.namespace;
      }
    }

    // if there is a namespace and no urlPrefix
    if (this.namespace && !this.urlPrefix) {
      if (
        this.namespace[0] === "/" &&
        this.namespace[this.namespace.length - 1] === "/"
      ) {
        namespace = this.namespace.substring(0, this.namespace.length - 1);
      }

      if (
        this.namespace[0] === "/" &&
        this.namespace[this.namespace.length - 1] !== "/"
      ) {
        namespace = this.namespace;
      }

      if (
        this.namespace[0] !== "/" &&
        this.namespace[this.namespace.length - 1] === "/"
      ) {
        let namespaceSub = this.namespace.substring(
          0,
          this.namespace.length - 1
        );
        namespace = `/${namespaceSub}`;
      }

      if (
        this.namespace[0] !== "/" &&
        this.namespace[this.namespace.length - 1] !== "/"
      ) {
        namespace = `/${this.namespace}`;
      }
    }

    // if no namespace
    if (!this.namespace) {
      namespace = "";
    }

    // check to see if path is a FQDN. if so, ignore any urlPrefix/namespace that was set
    if (/^https?:\/\//.test(path)) {
      fullPath += path;
    } else {
      // otherwise, if there is a urlPrefix, use that as the beginning of the path
      if (urlPrefix.length) {
        fullPath +=
          urlPrefix[urlPrefix.length - 1] === "/" ? urlPrefix : `${urlPrefix}/`;
      }

      // add the namespace to the path
      fullPath += namespace;

      // add a trailing slash to the path if it doesn't already contain one
      if (fullPath[fullPath.length - 1] !== "/") {
        fullPath += "/";
      }

      // finally add the configured path
      fullPath += path;

      // if we're making a same-origin request, ensure a / is prepended and
      // dedup any double slashes
      if (!/^https?:\/\//.test(fullPath)) {
        fullPath = `/${fullPath}`;
        fullPath = fullPath.replace(/\/+/g, "/");
      }
    }

    return fullPath;
  }

  passthrough(...args: (string | HTTPVerb[])[]) {
    let verbs: HTTPVerb[] = [
      "get",
      "post",
      "put",
      "delete",
      "patch",
      "options",
      "head",
    ];
    let lastArg = args[args.length - 1];
    let paths: string[] = [];

    if (args.length === 0) {
      paths = ["/**", "/"];
    } else if (Array.isArray(lastArg)) {
      verbs = lastArg;
    }
    // Need to loop because TS doesn't know if they're strings or arrays
    for (const arg of args) {
      if (typeof arg === "string") {
        paths.push(arg);
      }
    }

    paths.forEach((path) => {
      if (typeof path === "function") {
        this.passthroughChecks.push(path);
      } else {
        let fullPath = this._getFullPath(path);
        verbs.forEach((verb) => {
          this.router[verb].add([
            { path: fullPath, handler: this.playwrightPassthroughHandler },
          ]);
        });
      }
    });
  }

  start() {
    // TODO: mirage isn't async, our handlers' init is
  }

  shutdown() {
    // TODO: shutdown is never called due to: https://github.com/miragejs/miragejs/blob/34266bf7ebd200bbb1fade0ce7a7a9760cc93a88/lib/server.js#L664
    //  We're manually calling it in the test fixture for now.
    // TODO: check if "create" is called when we run a second test, otherwise we
    //  could setup the playwrightHandler in the start() call instead.
    if (this.page && this.playwrightHandler) {
      this.page.unroute(this.interceptUrlPattern, this.playwrightHandler);
    }
  }
}
