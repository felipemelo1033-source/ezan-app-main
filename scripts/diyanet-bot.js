// Dateipfad: scripts/diyanet-bot.js
const fs = require('fs');
const path = require('path');

const EMAIL = process.env.DIYANET_EMAIL;
const PASSWORD = process.env.DIYANET_PASSWORD;
const BASE_URL = "https://awqatsalah.diyanet.gov.tr/api";

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fetchApi(endpoint, token, method = "GET", body = null) {
    const options = {
        method: method,
        headers: { "Content-Type": "application/json" }
    };
    if (token) options.headers["Authorization"] = `Bearer ${token}`;
    if (body) options.body = JSON.stringify(body);

    const res = await fetch(BASE_URL + endpoint, options);
    if (!res.ok) throw new Error(`API Fehler bei ${endpoint}: ${res.status}`);
    return res.json();
}

async function run() {
    console.log("🤖 ATF Diyanet Bot gestartet...");
    const searchIndex = [];

    // Ordnerstruktur vorbereiten
    const locationsDir = path.join(__dirname, '../data/locations');
    const vakitlerDir = path.join(__dirname, '../data/vakitler');
    if (!fs.existsSync(locationsDir)) fs.mkdirSync(locationsDir, { recursive: true });
    if (!fs.existsSync(vakitlerDir)) fs.mkdirSync(vakitlerDir, { recursive: true });

    try {
        // 1. Login
        console.log("🔑 Logge bei Diyanet ein...");
        const loginData = await fetchApi("/Auth/Login", null, "POST", { email: EMAIL, password: PASSWORD });
        const token = loginData.data.token;
        console.log("✅ Login erfolgreich!");

        // 2. Wir definieren die Länder (1 = TR, 2 = DE, 3 = AT, etc.)
        // Um den Bot beim ersten Test kurz zu halten, testen wir es mit DE (2).
        // Später kannst du hier einfach [1, 2, 3, 4] eintragen.
        const targetCountries = [2]; 
        
        // Ländernamen für unser App-Menü (Hardcoded oder per API)
        const countryList = [
            { id: "2", name: "Almanya" }
        ];
        fs.writeFileSync(path.join(locationsDir, 'countries.json'), JSON.stringify(countryList));

        // 3. Crawler startet
        for (const countryId of targetCountries) {
            console.log(`\n🌍 Lade Bundesländer für Land-ID: ${countryId}`);
            const statesData = await fetchApi(`/Place/States/${countryId}`, token);
            await sleep(1000); // 1 Sekunde Pause für Diyanet
            
            // Speichere Eyalet-Liste (z.B. states_2.json)
            const statesMap = statesData.data.map(s => ({ id: s.id.toString(), name: s.name }));
            fs.writeFileSync(path.join(locationsDir, `states_${countryId}.json`), JSON.stringify(statesMap));

            for (const state of statesMap) {
                console.log(`  📍 Lade Städte für: ${state.name}`);
                const citiesData = await fetchApi(`/Place/Cities/${state.id}`, token);
                await sleep(1000);

                // Speichere Şehir-Liste (z.B. cities_850.json)
                const citiesMap = citiesData.data.map(c => ({ id: c.id.toString(), name: c.name }));
                fs.writeFileSync(path.join(locationsDir, `cities_${state.id}.json`), JSON.stringify(citiesMap));

                for (const city of citiesMap) {
                    // Für den Such-Index vormerken
                    searchIndex.push({ id: city.id, name: city.name, country: countryId.toString() });

                    // Gebetszeiten laden
                    console.log(`    ⏳ Lade Vakitler für: ${city.name} (${city.id})`);
                    const vakitlerData = await fetchApi(`/PrayerTime/Monthly/${city.id}`, token);
                    fs.writeFileSync(path.join(vakitlerDir, `${city.id}.json`), JSON.stringify(vakitlerData));
                    
                    await sleep(1500); // WICHTIG: 1.5 Sekunden Pause, sonst blockt Diyanet uns!
                }
            }
        }

        // 4. Such-Index speichern
        console.log("\n🔍 Speichere globalen Such-Index...");
        fs.writeFileSync(path.join(locationsDir, 'search_index.json'), JSON.stringify(searchIndex));

        console.log("🎉 Alle Daten erfolgreich aktualisiert!");

    } catch (error) {
        console.error("❌ SCHWERER FEHLER:", error);
        process.exit(1); // Damit GitHub merkt, dass es fehlgeschlagen ist
    }
}

run();
