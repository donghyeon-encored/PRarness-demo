const recipe = {
  baseServings: 4,
  ingredients: [
    { name: "Flour", amount: "1 1/2", unit: "cups" },
    { name: "Milk", amount: "1", unit: "cup" },
    { name: "Baking powder", amount: "0.5", unit: "tbsp" },
  ],
};

const ingredientsElement = document.querySelector("#ingredients");
const servingsElement = document.querySelector("#target-servings");
const statusElement = document.querySelector("#status");
const scaleButton = document.querySelector("#scale-button");

function renderIngredients(ingredients) {
  ingredientsElement.replaceChildren(...ingredients.map((ingredient) => {
    const item = document.createElement("li");
    const name = document.createElement("span");
    const amount = document.createElement("strong");

    name.textContent = ingredient.name;
    amount.textContent = `${ingredient.amount} ${ingredient.unit}`.trim();
    item.append(name, amount);
    return item;
  }));
}

async function scaleRecipe() {
  scaleButton.disabled = true;
  statusElement.textContent = "Scaling…";

  try {
    const response = await fetch("/api/scale-recipe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...recipe,
        targetServings: Number(servingsElement.value),
      }),
    });
    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error ?? "Could not scale this recipe");
    }

    renderIngredients(result.ingredients);
    statusElement.textContent = `Scaled by ${result.multiplier}×.`;
  } catch (error) {
    statusElement.textContent = error.message;
  } finally {
    scaleButton.disabled = false;
  }
}

renderIngredients(recipe.ingredients);
scaleButton.addEventListener("click", scaleRecipe);
