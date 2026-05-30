const form = document.querySelector("#search-form");
const input = document.querySelector("#location");
const statusBand = document.querySelector("#status");
const summary = document.querySelector("#summary");
const results = document.querySelector("#results");
const yardName = document.querySelector("#yard-name");
const yardLink = document.querySelector("#yard-link");
const carCount = document.querySelector("#car-count");
const listingCount = document.querySelector("#listing-count");
const submitButton = form.querySelector("button");

function setStatus(message, isError = false) {
  statusBand.hidden = !message;
  statusBand.textContent = message || "";
  statusBand.classList.toggle("error", isError);
}

function formatMoney(value) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: value % 1 ? 2 : 0,
  }).format(value);
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString();
}

function renderItemMeta(item) {
  const parts = [
    item.condition,
    item.partName ? `LKQ part: ${item.partName}` : "",
    item.soldDate ? `Sold ${formatDate(item.soldDate)}` : "",
  ].filter(Boolean);

  return parts.length ? `<div class="listing-meta">${parts.join(" | ")}</div>` : "";
}

function renderTopItems(items, priceList) {
  const card = document.createElement("article");
  card.className = "car-card top-card";

  const header = document.createElement("header");
  header.className = "car-header";
  header.innerHTML = `
    <div>
      <p class="section-kicker">Best flips across nearby yards</p>
      <h2 class="car-title">Top 20 estimated profit parts</h2>
    </div>
    <div class="car-actions">
      <span>${items.length} ranked profit comps</span>
      ${
        priceList?.priceUrl
          ? `<a href="${priceList.priceUrl}" target="_blank" rel="noreferrer">LKQ price list</a>`
          : ""
      }
    </div>
  `;
  card.append(header);

  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent =
      "No profit-ranked items were returned yet. The app needs sold eBay items and a matched LKQ part price.";
    card.append(empty);
    return card;
  }

  const table = document.createElement("table");
  table.className = "listing-table";
  table.innerHTML = `
    <thead>
      <tr>
        <th>Rank</th>
        <th>Sold item</th>
        <th>Source car</th>
        <th>Yard</th>
        <th>LKQ cost</th>
        <th>Sold price</th>
        <th>Profit</th>
      </tr>
    </thead>
    <tbody></tbody>
  `;

  const tbody = table.querySelector("tbody");
  items.forEach((item, index) => {
    const car = item.car || {};
    const sourceCar = [car.year, car.make, car.model].filter(Boolean).join(" ");
    const yard = item.yard || car.yard || {};
    const row = document.createElement("tr");
    row.innerHTML = `
      <td class="rank">${index + 1}</td>
      <td>
        <a href="${item.url}" target="_blank" rel="noreferrer">${item.title}</a>
        ${renderItemMeta(item)}
      </td>
      <td>${sourceCar || "Unknown"}</td>
      <td>${yard.name || "Unknown"}</td>
      <td>${formatMoney(item.partCost || 0)}</td>
      <td class="price">${formatMoney(item.price)}</td>
      <td class="profit">${formatMoney(item.profit || 0)}</td>
    `;
    tbody.append(row);
  });

  card.append(table);
  return card;
}

function renderResults(data) {
  summary.hidden = false;
  const yards = data.yards || [];
  yardName.textContent = yards.length ? yards.length.toString() : "No yards matched";
  yardLink.href = data.yard?.url || "#";
  yardLink.textContent = data.yard ? "Open nearest inventory" : "Open inventory";
  carCount.textContent = data.cars.length.toString();

  const totalListings = data.results.reduce(
    (total, result) => total + result.items.length,
    0,
  );
  listingCount.textContent = totalListings.toString();

  results.innerHTML = "";

  if (!data.yard) {
    results.innerHTML =
      '<div class="empty">No LKQ yards were found within 50 miles. Try a city and state, like "Denver CO" or "Santa Fe Springs CA".</div>';
    return;
  }

  if (!data.cars.length) {
    results.innerHTML =
      '<div class="empty">The yard matched, but no recent vehicles could be read from its inventory page.</div>';
    return;
  }

  if (data.results.some((result) => /status 403|forbidden/i.test(result.error || ""))) {
    setStatus(
      "LKQ inventory loaded, but eBay is blocking automated sold-listing reads. Use the eBay search links on each vehicle to open the completed listings directly.",
      true,
    );
  }

  const fragment = document.createDocumentFragment();
  fragment.append(renderTopItems(data.topItems || [], data.priceList));

  for (const result of data.results) {
    if (!result.car) {
      const card = document.createElement("article");
      card.className = "car-card";
      const header = document.createElement("header");
      header.className = "car-header";
      header.innerHTML = `
        <div>
          <h2 class="car-title">${result.yard?.name || "Yard lookup"}</h2>
        </div>
      `;
      card.append(header);
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = result.error || "Inventory lookup failed.";
      card.append(empty);
      fragment.append(card);
      continue;
    }

    const card = document.createElement("article");
    card.className = "car-card";

    const car = result.car;
    const topValue = result.items[0]?.price || 0;
    const header = document.createElement("header");
    header.className = "car-header";
    header.innerHTML = `
      <div>
        <h2 class="car-title">${car.year} ${car.make} ${car.model}</h2>
        <div class="listing-meta">${car.yard?.name || result.yard?.name || ""}</div>
      </div>
      <div class="car-actions">
        <span>${result.items.length} sold comps</span>
        ${topValue ? `<span>Top sale ${formatMoney(topValue)}</span>` : ""}
        ${
          result.ebayUrl
            ? `<a href="${result.ebayUrl}" target="_blank" rel="noreferrer">Open eBay search</a>`
            : ""
        }
      </div>
    `;
    card.append(header);

    if (result.error) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = /status 403|forbidden/i.test(result.error)
        ? "eBay blocked the automated lookup for this vehicle. Open the eBay search link to view sold completed listings in your browser."
        : `eBay lookup failed: ${result.error}`;
      card.append(empty);
      fragment.append(card);
      continue;
    }

    if (!result.items.length) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "No sold completed listings were found for this vehicle.";
      card.append(empty);
      fragment.append(card);
      continue;
    }

    const table = document.createElement("table");
    table.className = "listing-table";
    table.innerHTML = `
      <thead>
        <tr>
          <th>Sold item</th>
          <th>Price</th>
        </tr>
      </thead>
      <tbody></tbody>
    `;

    const tbody = table.querySelector("tbody");
    for (const item of result.items) {
      const row = document.createElement("tr");
      row.innerHTML = `
        <td>
          <a href="${item.url}" target="_blank" rel="noreferrer">${item.title}</a>
          ${renderItemMeta(item)}
        </td>
        <td class="price">${formatMoney(item.price)}</td>
      `;
      tbody.append(row);
    }

    card.append(table);
    fragment.append(card);
  }

  results.append(fragment);
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const location = input.value.trim();
  if (!location) return;

  submitButton.disabled = true;
  submitButton.textContent = "Searching";
  summary.hidden = true;
  results.innerHTML = "";
  setStatus("Finding LKQ yards within 50 miles, reading recent inventory, then checking eBay sold listings...");

  try {
    const response = await fetch(`/api/analyze?location=${encodeURIComponent(location)}`);
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "Search failed.");
    }
    setStatus("");
    renderResults(data);
  } catch (error) {
    setStatus(error.message || "Something went wrong.", true);
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = "Search";
  }
});
