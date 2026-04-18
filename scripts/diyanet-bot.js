const fs = require('fs');
const path = require('path');

const EMAIL = process.env.DIYANET_EMAIL;
const PASSWORD = process.env.DIYANET_PASSWORD;
const BASE_URL = "https://awqatsalah.diyanet.gov.tr"; 

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fetchApi(endpoint, token, method = "GET", body = null) {
    const options = {
        method: method,
        headers: { "Content-Type": "application/json" }
    };
    if (token) options.headers["Authorization"] = `Bearer ${token}`;
    if (body) options.body = JSON.stringify(body);

    const res = await fetch(BASE_URL + endpoint, options);
    if (!res.ok) {
        const errorText = await res.text();
        throw new Error(`API Fehler bei ${endpoint}: ${res.status} | Details: ${errorText}`);
    }
    return res.json();
}

async function run() {
    console.log("🤖 ATF Diyanet Bot gestartet...");
    const searchIndex = [];

    const locationsDir = path.join(__dirname, '../data/locations');
    const vakitlerDir = path.join(__dirname, '../data/vakitler');
    if (!fs.existsSync(locationsDir)) fs.mkdirSync(locationsDir, { recursive: true });
    if (!fs.existsSync(vakitlerDir)) fs.mkdirSync(vakitlerDir, { recursive: true });

    try {
        console.log("🔑 Sende Login-Daten an Diyanet...");
        
        const loginPayload = {
            email: EMAIL,
            password: PASSWORD
        };

        const loginData = await fetchApi("/Auth/Login", null, "POST", loginPayload);
        
        // HIER IST DIE REPARATUR (accessToken statt token)
        const token = loginData.data ? loginData.data.accessToken : null;

        if (!token) {
            throw new Error(`Kein Token erhalten! Diyanet sagt: ${JSON.stringify(loginData)}`);
        }

        console.log("✅ Echtes Token erfolgreich erhalten!");

        const targetCountries = [2]; 
        
        const countryList = [
            { id: "2", name: "Almanya" }
        ];
        fs.writeFileSync(path.join(locationsDir, 'countries.json'), JSON.stringify(countryList));

        for (const countryId of targetCountries) {
            console.log(`\n🌍 Lade Bundesländer für Land-ID: ${countryId}`);
            const statesData = await fetchApi(`/api/Place/States/${countryId}`, token);
            await sleep(1000); 
            
            const statesMap = statesData.data.map(s => ({ id: s.id.toString(), name: s.name }));
            fs.writeFileSync(path.join(locationsDir, `states_${countryId}.json`), JSON.stringify(statesMap));

            for (const state of statesMap) {
                console.log(`  📍 Lade Städte für: ${state.name}`);
                const citiesData = await fetchApi(`/api/Place/Cities/${state.id}`, token);
                await sleep(1000);

                const citiesMap = citiesData.data.map(c => ({ id: c.id.toString(), name: c.name }));
                fs.writeFileSync(path.join(locationsDir, `cities_${state.id}.json`), JSON.stringify(citiesMap));

                for (const city of citiesMap) {
                    searchIndex.push({ id: city.id, name: city.name, country: countryId.toString() });

                    console.log(`    ⏳ Lade Vakitler für: ${city.name} (${city.id})`);
                    const vakitlerData = await fetchApi(`/api/PrayerTime/Monthly/${city.id}`, token);
                    fs.writeFileSync(path.join(vakitlerDir, `${city.id}.json`), JSON.stringify(vakitlerData));
                    
                    await sleep(1500); 
                }
            }
        }

        console.log("\n🔍 Speichere globalen Such-Index...");
        fs.writeFileSync(path.join(locationsDir, 'search_index.json'), JSON.stringify(searchIndex));

        console.log("🎉 Alle Daten erfolgreich aktualisiert!");

    } catch (error) {
        console.error("❌ SCHWERER FEHLER:", error);
        process.exit(1); 
    }
}

run();
