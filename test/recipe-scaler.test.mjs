import assert from "node:assert/strict";
import test from "node:test";

import {
  RecipeValidationError,
  parseAmount,
  scaleRecipe,
} from "../src/components/recipe-scaler.mjs";

test("scales decimal ingredient amounts", () => {
  const result = scaleRecipe({
    baseServings: 4,
    targetServings: 10,
    ingredients: [
      { name: "Milk", amount: "1.5", unit: "cups" },
      { name: "Salt", amount: 0.25, unit: "tsp" },
    ],
  });

  assert.equal(result.multiplier, 2.5);
  assert.deepEqual(result.ingredients, [
    { name: "Milk", amount: 3.75, unit: "cups" },
    { name: "Salt", amount: 0.625, unit: "tsp" },
  ]);
});

test("does not mutate the source ingredients", () => {
  const ingredient = { name: "Eggs", amount: 2, unit: "" };

  scaleRecipe({
    baseServings: 2,
    targetServings: 4,
    ingredients: [ingredient],
  });

  assert.deepEqual(ingredient, { name: "Eggs", amount: 2, unit: "" });
});

test("rejects invalid serving and ingredient values", () => {
  assert.throws(
    () => scaleRecipe({ baseServings: 0, targetServings: 4, ingredients: [] }),
    RecipeValidationError,
  );
  assert.throws(
    () => scaleRecipe({ baseServings: true, targetServings: 4, ingredients: [] }),
    RecipeValidationError,
  );
  assert.throws(() => scaleRecipe(null), RecipeValidationError);
  assert.throws(() => parseAmount("not a number"), RecipeValidationError);
  assert.throws(() => parseAmount("2 cups"), RecipeValidationError);
  assert.throws(() => parseAmount("1abc"), RecipeValidationError);
});

test("rejects scaling results outside the supported numeric range", () => {
  assert.throws(
    () => scaleRecipe({
      baseServings: 1,
      targetServings: 1e308,
      ingredients: [{ name: "Flour", amount: 1e308, unit: "cups" }],
    }),
    RecipeValidationError,
  );
});

test("scales mixed-fraction amounts such as 1 1/2", () => {
  const result = scaleRecipe({
    baseServings: 4,
    targetServings: 8,
    ingredients: [
      { name: "Flour", amount: "1 1/2", unit: "cups" },
    ],
  });

  assert.deepEqual(result.ingredients, [
    { name: "Flour", amount: 3, unit: "cups" },
  ]);
});

test("rejects mixed fractions with a zero denominator", () => {
  assert.throws(
    () => parseAmount("1 1/0"),
    RecipeValidationError,
  );
});
