const fs = require('fs');
const path = require('path');

const EMAIL = process.env.DIYANET_EMAIL;
const PASSWORD = process.env.DIYANET_PASSWORD;
const BASE_URL = "https://awqatsalah.diyanet.gov.tr"; 

// Globale Variable für das Token
let currentAccessToken = "";

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// ==========================================
// 1. NEU: Separate Login-Funktion für den Auto-Retry
// ==========================================
async function loginToDiyanet() {
    console.log("🔄 Hole (neues) Token von Diyanet...");
    const loginPayload = { email: EMAIL, password: PASSWORD };
    
    const res = await fetch(BASE_URL + "/Auth/Login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(loginPayload)
    });

    if (!res.ok) {
        throw new Error(`❌ Login fehlgeschlagen! Status: ${res.status}`);
    }

    const loginData = await res.json();
    currentAccessToken = loginData.data ? loginData.data.accessToken : null;

    if (!currentAccessToken) throw new Error("Kein Token im Login-Response gefunden!");
    console.log("✅ Neues Token erfolgreich erhalten!");
}

// ==========================================
// 2. MODIFIZIERT: fetchApi mit 401-Erkennung
// ==========================================
async function fetchApi(endpoint, method = "GET", body = null, isRetry = false) {
    const options = {
        method: method,
        headers: { "Content-Type": "application/json" }
    };
    // Wir nutzen jetzt immer das globale Token
    if (currentAccessToken) options.headers["Authorization"] = `Bearer ${currentAccessToken}`;
    if (body) options.body = JSON.stringify(body);

    const res = await fetch(BASE_URL + endpoint, options);
    
    // ✨ WENN DAS TOKEN ABGELAUFEN IST (401)
    if (res.status === 401) {
        if (isRetry) {
            throw new Error(`❌ API Fehler bei ${endpoint}: 401 | Auch nach Login-Versuch fehlgeschlagen!`);
        }
        console.log(`⚠️ Token abgelaufen bei ${endpoint}. Logge automatisch neu ein...`);
        
        await loginToDiyanet(); // Neues Token holen
        
        // Exakt selbe Anfrage nochmal versuchen!
        return await fetchApi(endpoint, method, body, true); 
    }

    if (!res.ok) {
        const errorText = await res.text();
        throw new Error(`API Fehler bei ${endpoint}: ${res.status} | Details: ${errorText}`);
    }
    
    return res.json();
}

// ==========================================
// 3. HAUPT-SKRIPT
// ==========================================
async function run() {
    console.log("🤖 ATF Diyanet Bot gestartet...");
    
    // BATCH-MODUS (1, 2, 3, 4 oder ALL)
    const currentBatch = process.env.BATCH || "1";
    console.log(`🚀 Aktiver BATCH-Modus: ${currentBatch}`);

    const locationsDir = path.join(__dirname, '../data/locations');
    const vakitlerDir = path.join(__dirname, '../data/vakitler');
    if (!fs.existsSync(locationsDir)) fs.mkdirSync(locationsDir, { recursive: true });
    if (!fs.existsSync(vakitlerDir)) fs.mkdirSync(vakitlerDir, { recursive: true });

    // Such-Index clever laden, damit Batches alte Daten nicht löschen
    let searchIndex = [];
    const searchIndexPath = path.join(locationsDir, 'search_index.json');
    if (fs.existsSync(searchIndexPath)) {
        try {
            searchIndex = JSON.parse(fs.readFileSync(searchIndexPath, 'utf-8'));
        } catch(e) { console.log("Neuer Such-Index wird erstellt."); }
    }

    try {
        // Erstes Login beim Skript-Start
        await loginToDiyanet();

        console.log("🔍 Lade alle Länder von Diyanet...");
        // Da das Token global ist, brauchen wir es nicht mehr zu übergeben
        const countriesRes = await fetchApi("/api/Place/Countries");
        const allCountries = countriesRes.data; 

        // Speichere die komplette Länderliste (muss immer da sein)
        fs.writeFileSync(path.join(locationsDir, 'countries.json'), JSON.stringify(allCountries));
        console.log(`✅ Insgesamt ${allCountries.length} Länder gefunden.`);

        // ----------------------------------------
        // BATCH LOGIK: Liste zerschneiden
        // ----------------------------------------
        let targetCountries = [];
        if (currentBatch === "1") targetCountries = allCountries.slice(0, 52);
        else if (currentBatch === "2") targetCountries = allCountries.slice(52, 104);
        else if (currentBatch === "3") targetCountries = allCountries.slice(104, 156);
        else if (currentBatch === "4") targetCountries = allCountries.slice(156);
        else targetCountries = allCountries; // Fallback

        console.log(`🌍 Verarbeite ${targetCountries.length} Länder in diesem Durchlauf...`);

        // Wir entfernen aus dem bestehenden Suchindex alle Städte der LÄNDER, die wir JETZT neu laden,
        // um Duplikate zu vermeiden, behalten aber die aus den anderen Batches!
        const targetCountryIds = targetCountries.map(c => c.id.toString());
        searchIndex = searchIndex.filter(item => !targetCountryIds.includes(item.country));

        // ----------------------------------------
        // NORMALE SCHLEIFE
        // ----------------------------------------
        for (const country of targetCountries) {
            console.log(`\n🌍 Verarbeite: ${country.name} (ID: ${country.id})`);
            const statesData = await fetchApi(`/api/Place/States/${country.id}`);
            await sleep(1000); 
            
            const statesMap = statesData.data.map(s => ({ id: s.id.toString(), name: s.name }));
            fs.writeFileSync(path.join(locationsDir, `states_${country.id}.json`), JSON.stringify(statesMap));

            for (const state of statesMap) {
                console.log(`  📍 Städte für: ${state.name}`);
                const citiesData = await fetchApi(`/api/Place/Cities/${state.id}`);
                await sleep(1000);

                const citiesMap = citiesData.data.map(c => ({ id: c.id.toString(), name: c.name }));
                fs.writeFileSync(path.join(locationsDir, `cities_${state.id}.json`), JSON.stringify(citiesMap));

                for (const city of citiesMap) {
                    searchIndex.push({ id: city.id, name: city.name, country: country.id.toString() });

                    console.log(`    ⏳ Vakitler: ${city.name} (${city.id})`);
                    const vakitlerData = await fetchApi(`/api/PrayerTime/Monthly/${city.id}`);
                    fs.writeFileSync(path.join(vakitlerDir, `${city.id}.json`), JSON.stringify(vakitlerData));
                    
                    await sleep(1500); // Fair-Play-Pause
                }
            }
        }

        console.log("\n🔍 Speichere globalen Such-Index...");
        fs.writeFileSync(searchIndexPath, JSON.stringify(searchIndex));
        console.log("🎉 Fertig!");

    } catch (error) {
        console.error("❌ FEHLER:", error);
        process.exit(1); 
    }
}
run();
