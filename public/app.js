const API = "https://junkyard-pro.onrender.com";

const form        = document.querySelector("#search-form");
const input       = document.querySelector("#location");
const statusBand  = document.querySelector("#status");
const summary     = document.querySelector("#summary");
const results     = document.querySelector("#results");
const yardNameEl  = document.querySelector("#yard-name");
const yardLinkEl  = document.querySelector("#yard-link");
const carCountEl  = document.querySelector("#car-count");
const submitBtn   = form.querySelector("button");

function setStatus(msg, isError = false) {
  statusBand.hidden = !msg;
  statusBand.textContent = msg || "";
  statusBand.classList.toggle("error", isError);
}

function money(n) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: n % 1 ? 2 : 0 }).format(n);
}

async function api(path) {
  const r = await fetch(API + path);
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); }
  catch(_) { throw new Error(`Server returned non-JSON (status ${r.status}): ${text.slice(0, 120)}`); }
  if (!r.ok) throw new Error(data.error || "Request failed");
  return data;
}

function renderYardPicker(yards, onSelect) {
  results.innerHTML = "";
  const heading = document.createElement("h2");
  heading.textContent = "Select a yard:";
  results.append(heading);
  for (const yard of yards) {
    const btn = document.createElement("button");
    btn.className = "yard-btn";
    btn.innerHTML = `<strong>${yard.name}</strong><br><small>${yard.address || ""}</small>`;
    btn.onclick = () => onSelect(yard);
    results.append(btn);
  }
}

function renderInventory(yard, vehicles, ebayMap) {
  results.innerHTML = "";

  yardNameEl.textContent = yard.name;
  yardLinkEl.href = `https://www.pyp.com/inventory/${yard.id}/`;
  yardLinkEl.textContent = "Open full inventory";
  carCountEl.textContent = vehicles.length;
  summary.hidden = false;

  if (!vehicles.length) {
    results.innerHTML = '<div class="empty">No vehicles found in this yard\'s inventory.</div>';
    return;
  }

  for (const v of vehicles) {
    const card = document.createElement("article");
    card.className = "car-card";

    const listings = ebayMap[`${v.year}:${v.make}:${v.model}`] || [];
    const topListings = listings.slice(0, 8);

    card.innerHTML = `
      <header class="car-header">
        <div>
          <h2 class="car-title">${v.year} ${v.make} ${v.model}</h2>
          <div class="listing-meta">
            ${[v.color, v.section && "Section " + v.section, v.row && "Row " + v.row].filter(Boolean).join(" · ")}
          </div>
        </div>
        <div class="car-actions">
          <span>${listings.length} sold comps</span>
          ${listings.length ? `<a href="https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(v.year + " " + v.make + " " + v.model + " parts")}&LH_Sold=1&LH_Complete=1" target="_blank" rel="noreferrer">eBay search</a>` : ""}
        </div>
      </header>
    `;

    if (!topListings.length) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "No sold eBay listings found.";
      card.append(empty);
    } else {
      const table = document.createElement("table");
      table.className = "listing-table";
      table.innerHTML = `
        <thead><tr>
          <th>Sold item</th>
          <th>Sold price</th>
          <th>PYP cost</th>
          <th>Profit</th>
        </tr></thead>
        <tbody>${topListings.map(l => `
          <tr>
            <td><a href="${l.url || "#"}" target="_blank" rel="noreferrer">${l.title}</a>
              ${l.category ? `<div class="listing-meta">${l.category}</div>` : ""}
            </td>
            <td class="price">${money(l.soldPrice)}</td>
            <td>${l.pypPrice != null ? money(l.pypPrice) : "—"}</td>
            <td class="${l.profit > 0 ? "profit" : ""}">${l.profit != null ? money(l.profit) : "—"}</td>
          </tr>`).join("")}
        </tbody>
      `;
      card.append(table);
    }

    results.append(card);
  }
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const q = input.value.trim();
  if (!q) return;

  submitBtn.disabled = true;
  submitBtn.textContent = "Searching…";
  summary.hidden = true;
  results.innerHTML = "";
  setStatus("Finding yards…");

  try {
    // 1. Find yards
    const { yards } = await api(`/yards?q=${encodeURIComponent(q)}`);
    if (!yards?.length) throw new Error("No yards found near that location.");

    if (yards.length === 1) {
      await loadYard(yards[0]);
    } else {
      setStatus("");
      renderYardPicker(yards, loadYard);
      submitBtn.disabled = false;
      submitBtn.textContent = "Search";
    }
  } catch (err) {
    setStatus(err.message, true);
    submitBtn.disabled = false;
    submitBtn.textContent = "Search";
  }
});

async function loadYard(yard) {
  submitBtn.disabled = true;
  submitBtn.textContent = "Loading…";
  summary.hidden = true;
  results.innerHTML = "";
  setStatus("Loading inventory…");

  try {
    // 2. Inventory
    const inv = await api(`/inventory/${yard.id}`);
    if (inv.error) throw new Error(inv.error);
    const vehicles = inv.vehicles || [];

    setStatus(`Loading eBay sold listings for ${vehicles.length} vehicles…`);

    // 3. eBay listings for each vehicle (parallel, best-effort)
    const ebayMap = {};
    await Promise.all(vehicles.map(async (v) => {
      try {
        const data = await api(`/ebay?year=${v.year}&make=${encodeURIComponent(v.make)}&model=${encodeURIComponent(v.model)}`);
        ebayMap[`${v.year}:${v.make}:${v.model}`] = data.listings || [];
      } catch (_) {
        ebayMap[`${v.year}:${v.make}:${v.model}`] = [];
      }
    }));

    setStatus("");
    renderInventory(yard, vehicles, ebayMap);
  } catch (err) {
    setStatus(err.message, true);
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = "Search";
  }
}
