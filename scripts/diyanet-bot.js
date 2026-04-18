const fs = require('fs');
const path = require('path');

const EMAIL = process.env.DIYANET_EMAIL;
const PASSWORD = process.env.DIYANET_PASSWORD;
const BASE_URL = "https://awqatsalah.diyanet.gov.tr"; 

let currentAccessToken = "";
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

async function fetchApi(endpoint, method = "GET", body = null, isRetry = false) {
    const options = {
        method: method,
        headers: { "Content-Type": "application/json" }
    };
    if (currentAccessToken) options.headers["Authorization"] = `Bearer ${currentAccessToken}`;
    if (body) options.body = JSON.stringify(body);

    const res = await fetch(BASE_URL + endpoint, options);
    
    if (res.status === 401 && !isRetry) {
        console.log(`⚠️ Token abgelaufen. Re-Login...`);
        await loginToDiyanet();
        return await fetchApi(endpoint, method, body, true); 
    }

    if (!res.ok) {
        const errorText = await res.text();
        const error = new Error(errorText);
        error.status = res.status;
        throw error;
    }
    return res.json();
}

// ==========================================
// MAIN RUNNER
// ==========================================
async function run() {
    console.log("🤖 ATF Diyanet Bot (10-Batch-Edition) gestartet...");
    
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
            console.log(`\n🌍 [${country.id}] ${country.name}`);
            
            try {
                const statesData = await fetchApi(`/api/Place/States/${country.id}`);
                const statesMap = statesData.data.map(s => ({ id: s.id.toString(), name: s.name }));
                fs.writeFileSync(path.join(locationsDir, `states_${country.id}.json`), JSON.stringify(statesMap));
                await sleep(500); // Kurze Pause nach Bundesländern

                for (const state of statesMap) {
                    const citiesData = await fetchApi(`/api/Place/Cities/${state.id}`);
                    const citiesMap = citiesData.data.map(c => ({ id: c.id.toString(), name: c.name }));
                    fs.writeFileSync(path.join(locationsDir, `cities_${state.id}.json`), JSON.stringify(citiesMap));
                    await sleep(500); // Kurze Pause nach Städten-Liste

                    for (const city of citiesMap) {
                        try {
                            const vData = await fetchApi(`/api/PrayerTime/Monthly/${city.id}`);
                            fs.writeFileSync(path.join(vakitlerDir, `${city.id}.json`), JSON.stringify(vData));
                            searchIndex.push({ id: city.id, name: city.name, country: country.id.toString() });
                            console.log(`  ✅ ${city.name}`);
                        } catch (cityError) {
                            if (cityError.status === 404) console.warn(`  ⚠️ 404 Skip: ${city.name}`);
                            else throw cityError;
                        }
                        // HIER: Geändert von 1500 auf 1000ms
                        await sleep(1000); 
                    }
                }
            } catch (countryError) {
                console.error(`❌ Fehler bei Land ${country.name}:`, countryError.message);
            }
        }

        console.log("\n💾 Speichere Such-Index...");
        fs.writeFileSync(searchIndexPath, JSON.stringify(searchIndex));
        console.log("🎉 Batch abgeschlossen!");

    } catch (error) {
        console.error("❌ Kritischer Abbruch:", error);
        process.exit(1); 
    }
}
run();
