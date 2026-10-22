// ============ 1. Settings & state ============

// Open-Meteo unit names. "Switch to Imperial" just swaps all three at once.
const METRIC = { temperature: "celsius", wind: "kmh", precip: "mm" };
const IMPERIAL = { temperature: "fahrenheit", wind: "mph", precip: "inch" };
const UNIT_LABEL = { kmh: "km/h", mph: "mph", mm: "mm", inch: "in" };
const POPOVERS = [
  ["units-btn", "units-menu"],
  ["day-btn", "day-menu"],
]; // [button id, menu id]

// Everything on screen is drawn from this one object.
const state = {
  place: null, // the chosen location from geocoding
  units: { ...METRIC }, // one choice for temperature, wind and precipitation
  data: null, // forecast response from Open-Meteo
  selectedDay: 0, // index into data.daily (0 = today)
};

let suggestions = []; // geocoding results in the dropdown
let activeIndex = -1; // highlighted suggestion
let debounceTimer; // waits for the user to stop typing
let suggestId = 0; // ignores outdated suggestion responses
let requestId = 0; // ignores outdated search/forecast responses
let retryAction = null; // what the Retry button should repeat

const $ = (id) => document.getElementById(id);

// ============ 2. Weather codes -> icon + words ============

// Open-Meteo sends a numeric "weather code". We turn it into a description and an icon.
function describeWeather(code) {
  if (code === 0) return { icon: "☀️", text: "Sunny" };
  if (code <= 2) return { icon: "⛅", text: "Partly cloudy" };
  if (code === 3) return { icon: "☁️", text: "Overcast" };
  if (code <= 48) return { icon: "🌫️", text: "Fog" };
  if (code <= 57) return { icon: "🌦️", text: "Drizzle" };
  if (code <= 67) return { icon: "🌧️", text: "Rain" };
  if (code <= 77) return { icon: "❄️", text: "Snow" };
  if (code <= 82) return { icon: "🌧️", text: "Rain showers" };
  if (code <= 86) return { icon: "❄️", text: "Snow showers" };
  return { icon: "⛈️", text: "Storm" };
}

// The ONE place icons are drawn. To use the challenge's icon images later,
// change this to return `<img src="assets/images/..." alt="${w.text}" class="${sizeClass}">`.
function iconHtml(code, sizeClass) {
  const w = describeWeather(code);
  return `<span role="img" aria-label="${w.text}" class="${sizeClass}">${w.icon}</span>`;
}

// ============ 3. Talking to the API ============

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error("Request failed: " + response.status);
  return response.json();
}

// GEOCODING: city name -> list of places that include latitude and longitude.
// If nothing matches, the API leaves out "results", so we return [].
async function searchPlaces(name) {
  const url =
    "https://geocoding-api.open-meteo.com/v1/search?count=5&language=en&format=json&name=" +
    encodeURIComponent(name);
  const json = await fetchJson(url);
  return json.results || [];
}

// FORECAST URL: the place's latitude/longitude + what we want + the chosen units.
// timezone=auto makes times match the searched city instead of the visitor's device.
function buildForecastUrl(place, units) {
  const params = new URLSearchParams({
    latitude: place.latitude,
    longitude: place.longitude,
    current:
      "temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,wind_speed_10m,weather_code",
    hourly: "temperature_2m,weather_code",
    daily: "weather_code,temperature_2m_max,temperature_2m_min",
    timezone: "auto",
    forecast_days: 7,
    temperature_unit: units.temperature,
    wind_speed_unit: units.wind,
    precipitation_unit: units.precip,
  });
  return "https://api.open-meteo.com/v1/forecast?" + params;
}

// ============ 4. Screen states: start, loading, weather, empty, error ============

function setView(view) {
  $("intro").hidden = view === "error"; // error page hides heading + search
  $("error").hidden = view !== "error";
  $("weather").hidden = view !== "loading" && view !== "weather"; // skeleton and real data share one layout
  $("hero").dataset.loading = String(view === "loading");
  $("message").hidden = view !== "start" && view !== "empty";
}

function showMessage(text, view) {
  $("message").textContent = text;
  $("message").className =
    view === "empty"
      ? "mt-12 text-center text-2xl font-bold"
      : "mt-12 text-center text-xl text-muted";
  setView(view);
}

// Text for screen readers only (the visible UI already shows these states)
function announce(text) {
  $("sr-status").textContent = text;
}

function showError(retryFn) {
  retryAction = retryFn;
  setView("error");
  announce("Something went wrong. We couldn't connect to the server.");
}

function skeleton(classes) {
  const li = document.createElement("li");
  li.className = classes;
  li.setAttribute("aria-hidden", "true");
  return li;
}

// Loading look: dots in the hero, dashes in the stat cards, empty boxes elsewhere.
function renderLoading() {
  setView("loading");
  ["feels-like", "humidity", "wind", "precip"].forEach((id) => {
    $(id).textContent = "—";
  });
  $("daily-list").replaceChildren(
    ...Array.from({ length: 7 }, () => skeleton("panel h-[165px]")),
  );
  $("hourly-list").replaceChildren(
    ...Array.from({ length: 8 }, () => skeleton("h-[60px] rounded-lg bg-row")),
  );
  $("day-label").textContent = "–";
}

// Request the forecast for a place. Changing units calls this again,
// so the API converts every number and the labels always match.
async function loadWeather(place, keepDay = false) {
  const thisRequest = ++requestId;
  const day = keepDay ? state.selectedDay : 0;
  state.place = place;
  renderLoading();
  announce("Loading weather…");
  try {
    const data = await fetchJson(buildForecastUrl(place, state.units));
    if (thisRequest !== requestId) return; // a newer request replaced this one
    state.data = data;
    state.selectedDay = Math.min(day, data.daily.time.length - 1);
    renderAll();
    announce("Weather loaded for " + place.name);
  } catch (error) {
    if (thisRequest === requestId) showError(() => loadWeather(place, keepDay));
  }
}

// ============ 5. Drawing the weather ============

const round = (n) => Math.round(n);

function dayName(date, style) {
  // "2026-10-19" -> "Mon" / "Monday"
  return new Date(date + "T00:00").toLocaleDateString("en-US", {
    weekday: style,
  });
}
function hourLabel(hour) {
  // 14 -> "2 PM"
  return new Date(2000, 0, 1, hour).toLocaleTimeString("en-US", {
    hour: "numeric",
  });
}

function renderAll() {
  const { current, daily } = state.data;
  const u = state.units;
  const p = state.place;
  setView("weather");

  $("place-name").textContent = [p.name, p.country].filter(Boolean).join(", ");
  $("current-date").textContent = new Date(current.time).toLocaleDateString(
    "en-US",
    { weekday: "long", month: "short", day: "numeric", year: "numeric" },
  );
  $("current-icon").innerHTML = iconHtml(current.weather_code, "");
  $("current-temp").textContent = round(current.temperature_2m) + "°";
  $("feels-like").textContent = round(current.apparent_temperature) + "°";
  $("humidity").textContent = current.relative_humidity_2m + "%";
  $("wind").textContent =
    round(current.wind_speed_10m) + " " + UNIT_LABEL[u.wind];
  $("precip").textContent = current.precipitation + " " + UNIT_LABEL[u.precip];

  // Seven-day forecast: one card per day with high (left) and low (right).
  $("daily-list").replaceChildren(
    ...daily.time.map((date, i) => {
      const li = document.createElement("li");
      li.className =
        "panel flex h-[165px] flex-col items-center justify-between px-2 py-4";
      li.innerHTML = `<span>${dayName(date, "short")}</span>${iconHtml(daily.weather_code[i], "text-4xl")}
      <span class="flex w-full justify-between text-sm sm:text-base"><span>${round(daily.temperature_2m_max[i])}°</span>
      <span class="text-muted">${round(daily.temperature_2m_min[i])}°</span></span>`;
      return li;
    }),
  );

  // Day picker for the hourly panel: one button per forecast day.
  $("day-menu").replaceChildren(
    ...daily.time.map((date, i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "menu-item";
      b.dataset.index = i;
      b.textContent = dayName(date, "long");
      return b;
    }),
  );
  renderHourly();
}

// HOURLY: the API sends all 7 days of hours in one long list. Each time looks like
// "2026-10-19T14:00", so we keep the ones starting with the selected date.
// For today we start at the current hour; other days show all 24 hours.
function renderHourly() {
  const { hourly, daily, current } = state.data;
  const date = daily.time[state.selectedDay];
  const firstHour =
    state.selectedDay === 0 ? Number(current.time.slice(11, 13)) : 0;

  const rows = [];
  hourly.time.forEach((time, i) => {
    const hour = Number(time.slice(11, 13));
    if (!time.startsWith(date) || hour < firstHour) return;
    const li = document.createElement("li");
    li.className =
      "flex h-[60px] items-center gap-2 rounded-lg border border-edge bg-row px-4";
    li.innerHTML = `${iconHtml(hourly.weather_code[i], "text-3xl")}
      <span class="flex-1 text-xl">${hourLabel(hour)}</span><span>${round(hourly.temperature_2m[i])}°</span>`;
    rows.push(li);
  });
  $("hourly-list").replaceChildren(...rows);
  $("hourly-list").scrollTop = 0;
  $("day-label").textContent = dayName(date, "long");
  [...$("day-menu").children].forEach((b, i) =>
    b.setAttribute("aria-pressed", String(i === state.selectedDay)),
  );
}

// ============ 6. Search box & suggestions ============

function showSuggestions(list) {
  suggestions = list;
  const box = $("suggestions");
  box.replaceChildren(
    ...list.map((place, i) => {
      const li = document.createElement("li");
      li.id = "suggestion-" + i;
      li.setAttribute("role", "option");
      li.className =
        "cursor-pointer rounded-lg px-3 py-2.5 hover:bg-row aria-selected:bg-row";
      li.textContent = [place.name, place.admin1, place.country]
        .filter(Boolean)
        .join(", "); // textContent is safe
      li.addEventListener("mousedown", (e) => {
        e.preventDefault();
        choosePlace(place);
      });
      return li;
    }),
  );
  box.hidden = list.length === 0;
  $("search-input").setAttribute("aria-expanded", String(list.length > 0));
  highlight(list.length ? 0 : -1); // first suggestion is highlighted, like the design
}

// "Search in progress" row shown while we wait for geocoding
function showProgress() {
  suggestions = [];
  activeIndex = -1;
  $("suggestions").innerHTML =
    `<li role="presentation" class="flex items-center gap-3 px-3 py-2.5 text-base">
    <svg class="icon h-4 w-4 animate-spin" aria-hidden="true"><use href="#i-spinner"/></svg>Search in progress</li>`;
  $("suggestions").hidden = false;
  $("search-input").setAttribute("aria-expanded", "true");
}

function highlight(index) {
  activeIndex = index;
  suggestions.forEach((_, i) =>
    $("suggestion-" + i).setAttribute("aria-selected", String(i === index)),
  );
  if (index >= 0)
    $("search-input").setAttribute(
      "aria-activedescendant",
      "suggestion-" + index,
    );
  else $("search-input").removeAttribute("aria-activedescendant");
}

function choosePlace(place) {
  $("search-input").value = place.name;
  showSuggestions([]);
  loadWeather(place);
}

// Search button / Enter with no suggestion: look the text up, use the first match.
async function runSearch(text) {
  const thisRequest = ++requestId;
  showProgress();
  announce("Searching…");
  try {
    const results = await searchPlaces(text);
    if (thisRequest !== requestId) return;
    showSuggestions([]);
    if (results.length === 0) {
      state.place = null;
      showMessage("No search result found!", "empty");
      announce("No search result found.");
      return;
    }
    loadWeather(results[0]);
  } catch (error) {
    if (thisRequest !== requestId) return;
    showSuggestions([]);
    showError(() => runSearch(text));
  }
}

// While typing: wait 300ms after the last key, then fetch suggestions.
$("search-input").addEventListener("input", (event) => {
  clearTimeout(debounceTimer);
  suggestId++;
  showSuggestions([]);
  const text = event.target.value.trim();
  if (text.length < 2) return;
  debounceTimer = setTimeout(async () => {
    const id = ++suggestId;
    showProgress();
    try {
      const results = await searchPlaces(text);
      if (id === suggestId) showSuggestions(results);
    } catch (error) {
      if (id === suggestId) showSuggestions([]); // the Search button reports real errors
    }
  }, 300);
});

$("search-input").addEventListener("keydown", (event) => {
  if (!suggestions.length) return;
  if (event.key === "ArrowDown") {
    event.preventDefault();
    highlight((activeIndex + 1) % suggestions.length);
  }
  if (event.key === "ArrowUp") {
    event.preventDefault();
    highlight((activeIndex - 1 + suggestions.length) % suggestions.length);
  }
});

$("search-form").addEventListener("submit", (event) => {
  event.preventDefault();
  clearTimeout(debounceTimer);
  suggestId++;
  if (activeIndex >= 0 && suggestions[activeIndex])
    return choosePlace(suggestions[activeIndex]);
  const text = $("search-input").value.trim();
  if (text) runSearch(text);
});

// ============ 7. Dropdowns, units and retry ============

function closePopovers(refocus = false) {
  POPOVERS.forEach(([buttonId, menuId]) => {
    if (!$(menuId).hidden && refocus) $(buttonId).focus();
    $(menuId).hidden = true;
    $(buttonId).setAttribute("aria-expanded", "false");
  });
}

POPOVERS.forEach(([buttonId, menuId]) => {
  $(buttonId).addEventListener("click", () => {
    const willOpen = $(menuId).hidden;
    closePopovers();
    $(menuId).hidden = !willOpen;
    $(buttonId).setAttribute("aria-expanded", String(willOpen));
  });
});

document.addEventListener("click", (event) => {
  if (!event.target.closest("[data-popover]")) closePopovers();
  if (!event.target.closest("#search-form")) showSuggestions([]);
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closePopovers(true);
    showSuggestions([]);
  }
});

// Show checkmarks on the chosen units and the right "Switch to ..." label.
function updateUnitsMenu() {
  document.querySelectorAll("[data-unit]").forEach((b) => {
    b.setAttribute(
      "aria-pressed",
      String(state.units[b.dataset.unit] === b.dataset.value),
    );
  });
  const allImperial = Object.keys(IMPERIAL).every(
    (k) => state.units[k] === IMPERIAL[k],
  );
  $("units-switch").textContent = allImperial
    ? "Switch to Metric"
    : "Switch to Imperial";
}

$("units-menu").addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  if (button.id === "units-switch") {
    const allImperial = Object.keys(IMPERIAL).every(
      (k) => state.units[k] === IMPERIAL[k],
    );
    state.units = allImperial ? { ...METRIC } : { ...IMPERIAL };
  } else {
    state.units[button.dataset.unit] = button.dataset.value;
  }
  updateUnitsMenu();
  if (state.place) loadWeather(state.place, true); // refetch in the new units, keep the selected day
});

// Picking a day only redraws the hourly list; no new request is needed.
$("day-menu").addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  state.selectedDay = Number(button.dataset.index);
  renderHourly();
  closePopovers(true);
});

$("retry-btn").addEventListener("click", () => retryAction && retryAction());

// ============ 8. Start ============
updateUnitsMenu();
showMessage("Search for a place to see its weather.", "start");
