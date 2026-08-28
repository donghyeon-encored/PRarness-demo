export class RecipeValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "RecipeValidationError";
  }
}

function requirePositiveNumber(value, field) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new RecipeValidationError(`${field} must be a positive number`);
  }

  return value;
}

export function parseAmount(value) {
  if (typeof value !== "number" && typeof value !== "string") {
    throw new RecipeValidationError("ingredient amount must be a number or string");
  }

  const text = String(value).trim();
  const isDecimal = /^(?:\d+(?:\.\d*)?|\.\d+)$/.test(text);
  const mixedFraction = /^(\d+)\s+(\d+)\/(\d+)$/.exec(text);

  if (typeof value === "string" && !isDecimal && !mixedFraction) {
    throw new RecipeValidationError("ingredient amount has an unsupported format");
  }

  let amount = typeof value === "number" ? value : Number.parseFloat(text);

  if (mixedFraction) {
    const [, wholeText, numeratorText, denominatorText] = mixedFraction;
    const denominator = Number(denominatorText);

    if (denominator === 0) {
      throw new RecipeValidationError("ingredient amount fraction denominator must not be zero");
    }

    amount = Number(wholeText) + (Number(numeratorText) / denominator);
  }

  if (!Number.isFinite(amount) || amount <= 0) {
    throw new RecipeValidationError("ingredient amount must be positive");
  }

  return amount;
}

function roundAmount(value, field) {
  if (!Number.isFinite(value)) {
    throw new RecipeValidationError(`${field} is outside the supported range`);
  }

  const rounded = Number(value.toFixed(3));
  if (rounded <= 0) {
    throw new RecipeValidationError(`${field} is too small to represent`);
  }

  return rounded;
}

export function createShoppingList(ingredients) {
  const items = new Map();

  for (const ingredient of ingredients) {
    const key = ingredient.name.toLowerCase();
    const existing = items.get(key);

    if (existing) {
      existing.amount = roundAmount(
        existing.amount + ingredient.amount,
        `${ingredient.name} shopping list amount`,
      );
      continue;
    }

    items.set(key, { ...ingredient });
  }

  return [...items.values()];
}

export function scaleRecipe(recipe) {
  if (!recipe || typeof recipe !== "object" || Array.isArray(recipe)) {
    throw new RecipeValidationError("recipe must be an object");
  }

  const { baseServings, targetServings, ingredients } = recipe;
  const base = requirePositiveNumber(baseServings, "baseServings");
  const target = requirePositiveNumber(targetServings, "targetServings");

  if (!Array.isArray(ingredients) || ingredients.length === 0) {
    throw new RecipeValidationError("ingredients must be a non-empty array");
  }

  const multiplier = roundAmount(target / base, "multiplier");
  const scaledIngredients = ingredients.map((ingredient, index) => {
    if (!ingredient || typeof ingredient.name !== "string" || !ingredient.name.trim()) {
      throw new RecipeValidationError(`ingredients[${index}].name is required`);
    }

    return {
      name: ingredient.name.trim(),
      amount: roundAmount(
        parseAmount(ingredient.amount) * multiplier,
        `ingredients[${index}].amount`,
      ),
      unit: typeof ingredient.unit === "string" ? ingredient.unit.trim() : "",
    };
  });

  return {
    baseServings: base,
    targetServings: target,
    multiplier,
    ingredients: scaledIngredients,
    shoppingList: createShoppingList(scaledIngredients),
  };
}
