const fs = require('fs');
const path = require('path');

const EMAIL = process.env.DIYANET_EMAIL;
const PASSWORD = process.env.DIYANET_PASSWORD;
const BASE_URL = "https://awqatsalah.diyanet.gov.tr";

let currentAccessToken = "";
let reLoginCount = 0;
const MAX_RELOGINS = 3;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// ==========================================
// TOKEN MANAGEMENT
// ==========================================
async function loginToDiyanet() {
    console.log("🔄 Hole (neues) Token von Diyanet...");
    const loginPayload = { email: EMAIL, password: PASSWORD };
    const res = await fetch(BASE_URL + "/Auth/Login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(loginPayload)
    });
    if (!res.ok) throw new Error(`❌ Login fehlgeschlagen! Status: ${res.status}`);
    const loginData = await res.json();
    currentAccessToken = loginData.data ? loginData.data.accessToken : null;
    if (!currentAccessToken) throw new Error("Kein Token erhalten!");
    console.log("✅ Token erhalten.");
}

// ==========================================
// API FETCH (Mit Timeout, 401-Re-Login, 429/5xx-Backoff)
// ==========================================
async function fetchApi(endpoint, method = "GET", body = null, attempt = 0) {
    const MAX_ATTEMPTS = 4; // Initial + 3 Retries für transiente Fehler
    const options = {
        method: method,
        headers: { "Content-Type": "application/json" }
    };
    if (currentAccessToken) options.headers["Authorization"] = `Bearer ${currentAccessToken}`;
    if (body) options.body = JSON.stringify(body);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 20000);
    options.signal = controller.signal;

    try {
        const res = await fetch(BASE_URL + endpoint, options);
        clearTimeout(timeoutId);

        // 401 → Token abgelaufen, Counter-basierter Re-Login
        if (res.status === 401) {
            if (reLoginCount >= MAX_RELOGINS) {
                throw new Error(`Token konnte ${MAX_RELOGINS}x nicht erneuert werden — Abbruch.`);
            }
            reLoginCount++;
            console.log(`⚠️ Token abgelaufen (Re-Login #${reLoginCount}/${MAX_RELOGINS}). Re-Login...`);
            await loginToDiyanet();
            return await fetchApi(endpoint, method, body, attempt); // gleicher attempt-Zähler
        }

        // 429 (Rate Limit) oder 5xx (Server-Fehler) → exponentielles Backoff
        if ((res.status === 429 || res.status >= 500) && attempt < MAX_ATTEMPTS - 1) {
            const waitSec = Math.min(60, 5 * Math.pow(2, attempt)); // 5s, 10s, 20s, 40s, cap 60s
            console.warn(`⚠️ HTTP ${res.status} bei ${endpoint} → warte ${waitSec}s und retry (${attempt + 1}/${MAX_ATTEMPTS - 1})`);
            await sleep(waitSec * 1000);
            return await fetchApi(endpoint, method, body, attempt + 1);
        }

        if (!res.ok) {
            const errorText = await res.text();
            const error = new Error(errorText);
            error.status = res.status;
            throw error;
        }
        return await res.json();

    } catch (err) {
        clearTimeout(timeoutId);

        // Timeout (AbortError) oder Netz-Fehler → ebenfalls mit Backoff retryen
        const isTransient = err.name === 'AbortError' || err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT';
        if (isTransient && attempt < MAX_ATTEMPTS - 1) {
            const waitSec = Math.min(60, 5 * Math.pow(2, attempt));
            console.warn(`⏳ Transient (${err.name || err.code}) bei ${endpoint}. Retry in ${waitSec}s (${attempt + 1}/${MAX_ATTEMPTS - 1})`);
            await sleep(waitSec * 1000);
            return await fetchApi(endpoint, method, body, attempt + 1);
        }
        throw err;
    }
}

// ==========================================
// ATOMIC WRITE für search_index.json
// (verhindert kaputte JSON-Datei, falls Prozess mittendrin abbricht)
// ==========================================
function saveSearchIndexAtomic(filePath, data) {
    const tmpPath = filePath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(data));
    fs.renameSync(tmpPath, filePath);
}

// ==========================================
// MAIN RUNNER
// ==========================================
async function run() {
    console.log("🤖 ATF Diyanet Bot (10-Batch-Edition + Timeout-Schutz) gestartet...");
    const batchInput = process.env.BATCH || "1";
    const locationsDir = path.join(__dirname, '../data/locations');
    const vakitlerDir = path.join(__dirname, '../data/vakitler');

    if (!fs.existsSync(locationsDir)) fs.mkdirSync(locationsDir, { recursive: true });
    if (!fs.existsSync(vakitlerDir)) fs.mkdirSync(vakitlerDir, { recursive: true });

    let searchIndex = [];
    const searchIndexPath = path.join(locationsDir, 'search_index.json');
    if (fs.existsSync(searchIndexPath)) {
        try { searchIndex = JSON.parse(fs.readFileSync(searchIndexPath, 'utf-8')); } catch(e) {}
    }

    try {
        await loginToDiyanet();
        const countriesRes = await fetchApi("/api/Place/Countries");
        const allCountries = countriesRes.data;
        fs.writeFileSync(path.join(locationsDir, 'countries.json'), JSON.stringify(allCountries));

        // 10-Batch Logik
        let targetCountries = [];
        if (batchInput === "ALL") {
            targetCountries = allCountries;
        } else {
            const bNum = parseInt(batchInput);
            const total = allCountries.length;
            const size = Math.ceil(total / 10);
            const start = (bNum - 1) * size;
            const end = start + size;
            targetCountries = allCountries.slice(start, end);
            console.log(`📦 Batch ${bNum}/10: Verarbeite Länder Index ${start} bis ${end}`);
        }

        const targetCountryIds = targetCountries.map(c => c.id.toString());
        searchIndex = searchIndex.filter(item => !targetCountryIds.includes(item.country));

        for (const country of targetCountries) {
            console.log(`\n🌍 Verarbeite: ${country.name} (ID: ${country.id})`);

            try {
                const statesData = await fetchApi(`/api/Place/States/${country.id}`);
                const statesMap = statesData.data.map(s => ({ id: s.id.toString(), name: s.name }));
                fs.writeFileSync(path.join(locationsDir, `states_${country.id}.json`), JSON.stringify(statesMap));
                await sleep(500);

                for (const state of statesMap) {
                    console.log(`  📍 Städte für: ${state.name}`);

                    const citiesData = await fetchApi(`/api/Place/Cities/${state.id}`);
                    const citiesMap = citiesData.data.map(c => ({ id: c.id.toString(), name: c.name }));
                    fs.writeFileSync(path.join(locationsDir, `cities_${state.id}.json`), JSON.stringify(citiesMap));
                    await sleep(500);

                    for (const city of citiesMap) {
                        try {
                            console.log(`    ⏳ Vakitler: ${city.name} (${city.id})`);
                            const vData = await fetchApi(`/api/PrayerTime/Monthly/${city.id}`);
                            fs.writeFileSync(path.join(vakitlerDir, `${city.id}.json`), JSON.stringify(vData));
                            searchIndex.push({ id: city.id, name: city.name, country: country.id.toString() });
                        } catch (cityError) {
                            if (cityError.status === 404) {
                                console.warn(`    ⚠️ Übersprungen: Keine Daten für ${city.name} (404)`);
                            } else {
                                throw cityError;
                            }
                        }
                        await sleep(1000);
                    }
                }

                // 💾 NACH JEDEM LAND: Search-Index atomar speichern,
                // damit bei Crash nicht alles weg ist.
                saveSearchIndexAtomic(searchIndexPath, searchIndex);
                console.log(`💾 Search-Index gespeichert (${searchIndex.length} Städte).`);

            } catch (countryError) {
                console.error(`❌ Fehler bei Land ${country.name}:`, countryError.message);
                // Auch bei Fehler den bisherigen Stand sichern
                saveSearchIndexAtomic(searchIndexPath, searchIndex);
            }
        }

        console.log("\n💾 Finale Speicherung Such-Index...");
        saveSearchIndexAtomic(searchIndexPath, searchIndex);
        console.log("🎉 Batch abgeschlossen!");

    } catch (error) {
        console.error("❌ Kritischer Abbruch:", error);
        // Best-Effort: was wir bis hierhin haben, persistieren
        try { saveSearchIndexAtomic(searchIndexPath, searchIndex); } catch(e) {}
        process.exit(1);
    }
}
run();
