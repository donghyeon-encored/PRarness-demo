import assert from "node:assert/strict";
import test from "node:test";

import {
  createShoppingList,
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

test("combines repeated ingredients into a shopping list", () => {
  const ingredients = [
    { name: "Flour", amount: 1.5, unit: "cups" },
    { name: "flour", amount: 0.5, unit: "cups" },
    { name: "Milk", amount: 1, unit: "cup" },
  ];

  assert.deepEqual(createShoppingList(ingredients), [
    { name: "Flour", amount: 2, unit: "cups" },
    { name: "Milk", amount: 1, unit: "cup" },
  ]);
  assert.equal(ingredients[0].amount, 1.5);
});

test("combines same-name ingredients regardless of unit", () => {
  const ingredients = [
    { name: "Flour", amount: 1, unit: "cups" },
    { name: "Salt", amount: 0.5, unit: "tsp" },
    { name: "flour", amount: 2, unit: "tbsp" },
  ];

  assert.deepEqual(createShoppingList(ingredients), [
    { name: "Flour", amount: 3, unit: "cups" },
    { name: "Salt", amount: 0.5, unit: "tsp" },
  ]);
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
    ingredients: [{ name: "Flour", amount: "1 1/2", unit: "cups" }],
  });

  assert.deepEqual(result.ingredients, [
    { name: "Flour", amount: 3, unit: "cups" },
  ]);
});

test("rejects malformed and zero-denominator fractions", () => {
  for (const amount of ["1/2", "1 1/", "1 /2", "1 1 / 2", "1 1/0"]) {
    assert.throws(() => parseAmount(amount), RecipeValidationError);
  }
});
