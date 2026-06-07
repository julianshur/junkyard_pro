const API = "https://junkyard-pro.onrender.com";

const form       = document.querySelector("#search-form");
const input      = document.querySelector("#location");
const statusBand = document.querySelector("#status");
const summary    = document.querySelector("#summary");
const results    = document.querySelector("#results");
const yardNameEl = document.querySelector("#yard-name");
const yardLinkEl = document.querySelector("#yard-link");
const carCountEl = document.querySelector("#car-count");
const compCountEl = document.querySelector("#comp-count");
const submitBtn  = form.querySelector("button");

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
  catch(_) { throw new Error(`Server error (${r.status}): ${text.slice(0, 120)}`); }
  if (!r.ok) throw new Error(data.error || "Request failed");
  return data;
}

async function apiPoll(path, intervalMs = 4000, maxWaitMs = 120000) {
  const deadline = Date.now() + maxWaitMs;
  while (true) {
    const data = await api(path);
    if (data.error) throw new Error(data.error);
    if (data.status === "scraping") {
      if (Date.now() > deadline) throw new Error("Timed out — try again.");
      await new Promise(r => setTimeout(r, intervalMs));
      continue;
    }
    return data;
  }
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

function ebaySearchUrl(v) {
  return `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(v.year + " " + v.make + " " + v.model + " engine")}&LH_Sold=1&LH_Complete=1`;
}

function buildCard(v) {
  const card = document.createElement("article");
  card.className = "car-card";
  card.id = `card-${v.year}-${v.make}-${v.model}`.replace(/\s+/g, "-");
  const meta = [v.color, v.section && "Section " + v.section, v.row && "Row " + v.row].filter(Boolean).join(" · ");
  card.innerHTML = `
    <header class="car-header">
      <div>
        <h2 class="car-title">${v.year} ${v.make} ${v.model}</h2>
        <div class="listing-meta">${meta}</div>
      </div>
      <div class="car-actions">
        <span class="comp-count">Loading…</span>
        <a href="${ebaySearchUrl(v)}" target="_blank" rel="noreferrer">eBay search</a>
      </div>
    </header>
    <div class="card-body"><div class="empty">Loading eBay sold listings…</div></div>
  `;
  return card;
}

function updateCard(v, listings) {
  const id = `card-${v.year}-${v.make}-${v.model}`.replace(/\s+/g, "-");
  const card = document.getElementById(id);
  if (!card) return;

  const countEl = card.querySelector(".comp-count");
  const body = card.querySelector(".card-body");

  if (!listings.length) {
    if (countEl) countEl.textContent = "0 sold comps";
    body.innerHTML = '<div class="empty">No sold eBay listings found.</div>';
    return;
  }

  if (countEl) countEl.textContent = `${listings.length} sold comps`;

  const top = listings.slice(0, 8);
  body.innerHTML = `
    <table class="listing-table">
      <thead><tr>
        <th>eBay listing</th><th>Listed price</th><th>PYP cost</th><th>Est. profit</th>
      </tr></thead>
      <tbody>${top.map(l => `
        <tr>
          <td>
            <a href="${l.url || "#"}" target="_blank" rel="noreferrer">${l.title}</a>
            ${l.category ? `<div class="listing-meta">${l.category}</div>` : ""}
          </td>
          <td class="price">${money(l.soldPrice)}</td>
          <td>${l.pypPrice != null ? money(l.pypPrice) : "—"}</td>
          <td class="${(l.profit||0) > 0 ? "profit" : ""}">${l.pypPrice != null ? money(l.soldPrice - l.pypPrice) : "—"}</td>
        </tr>`).join("")}
      </tbody>
    </table>
  `;

  // Update global comp count
  const total = document.querySelectorAll(".comp-count");
  let sum = 0;
  total.forEach(el => { const n = parseInt(el.textContent); if (!isNaN(n)) sum += n; });
  compCountEl.textContent = sum;
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
  setStatus("Loading inventory from pyp.com… (first load takes ~30s)");

  try {
    const inv = await apiPoll(`/inventory/${yard.id}`);
    const vehicles = inv.vehicles || [];

    // Show inventory immediately
    yardNameEl.textContent = yard.name;
    yardLinkEl.href = `https://www.pyp.com/inventory/${yard.id}/`;
    carCountEl.textContent = vehicles.length;
    compCountEl.textContent = "…";
    summary.hidden = false;
    setStatus("");
    submitBtn.disabled = false;
    submitBtn.textContent = "Search";

    if (!vehicles.length) {
      results.innerHTML = '<div class="empty">No vehicles found in this yard\'s inventory.</div>';
      return;
    }

    // Render all cards immediately with loading state
    for (const v of vehicles) results.append(buildCard(v));

    // Load eBay for each vehicle sequentially, updating cards as data arrives
    let totalComps = 0;
    for (const v of vehicles) {
      try {
        const data = await apiPoll(
          `/ebay?year=${v.year}&make=${encodeURIComponent(v.make)}&model=${encodeURIComponent(v.model)}`,
          4000, 90000
        );
        const listings = data.listings || [];
        totalComps += listings.length;
        compCountEl.textContent = totalComps;
        updateCard(v, listings);
      } catch(_) {
        updateCard(v, []);
      }
    }
    compCountEl.textContent = totalComps;

  } catch (err) {
    setStatus(err.message, true);
    submitBtn.disabled = false;
    submitBtn.textContent = "Search";
  }
}
