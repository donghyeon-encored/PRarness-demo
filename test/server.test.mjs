import assert from "node:assert/strict";
import test from "node:test";

import { createRecipeServer } from "../src/server.mjs";

async function withServer(run) {
  const server = createRecipeServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const address = server.address();
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

test("serves a health response", async () => {
  await withServer(async (origin) => {
    const response = await fetch(`${origin}/health`);

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "ok" });
  });
});

test("scales a recipe through the JSON API", async () => {
  await withServer(async (origin) => {
    const response = await fetch(`${origin}/api/scale-recipe`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        baseServings: 2,
        targetServings: 6,
        ingredients: [
          { name: "Eggs", amount: 2, unit: "" },
          { name: "Eggs", amount: 1, unit: "" },
        ],
      }),
    });

    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.ingredients[0].amount, 6);
    assert.deepEqual(result.shoppingList, [
      { name: "Eggs", amount: 9, unit: "" },
    ]);
  });
});

test("returns a client error for malformed JSON", async () => {
  await withServer(async (origin) => {
    const response = await fetch(`${origin}/api/scale-recipe`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not-json",
    });

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: "request body must be valid JSON",
    });
  });
});

test("returns a client error when the JSON body is not an object", async () => {
  await withServer(async (origin) => {
    const response = await fetch(`${origin}/api/scale-recipe`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "null",
    });

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: "recipe must be an object",
    });
  });
});
