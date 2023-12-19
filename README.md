# mirage-playwright
Experimental MirageJS interceptor for Playwright.

Example usage:
```javascript
// server.js
import { PlaywrightInterceptor } from "mirage-playwright";
import { createServer } from "miragejs";

export function makeServer({ environment = "test", page }: MakeServerArgs) {
    const server = createServer({
        interceptor: new PlaywrightInterceptor(),
        // We just intercept requests to `/api`, meaning at this time we don't need to configure passthroughs.
        // Not configuring this spams the Playwright Actions tab with a lot of noise. Unsure if there is a good workaround.
        interceptUrlPattern: "/api/**",
        page,
        
        // ... other Mirage configuration
    });
    
    return server;
};
```

```javascript
// test-helper.js
import { test as testBase, expect } from "@playwright/test";
import { makeServer } from "./server";

const test = testBase.extend({
    mirageServer: async ({page}, use) => {
        const mirageServer = makeServer({
            environment: "test",
            page,
        });

        await use(mirageServer);

        // TODO: shutdown is not automatically called due to: https://github.com/miragejs/miragejs/blob/34266bf7ebd200bbb1fade0ce7a7a9760cc93a88/lib/server.js#L664
        mirageServer.interceptor.shutdown();
        mirageServer.shutdown();
    },
});
```

```javascript
// my-test.js
import { test, expect } from "./test-helper";

test.describe('my example test module', () => {
    test("my example test", async ({ page, mirageServer }) => {
        mirageServer.create("my-mirage-model", {
            name: "Foo",
        });
        
        await page.goto('/');
    });
});
```