const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');

const req = createRequire(path.join(__dirname, 'server.js'));
const axios = req('axios');
const sqlite3 = req('sqlite3');

const envText = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
const weatherKey = envText.match(/^WEATHER_API_KEY=(.+)$/m)?.[1]?.trim();

if (!weatherKey) {
  throw new Error('WEATHER_API_KEY missing in server/.env');
}

const db = new sqlite3.Database(path.join(__dirname, 'terminal.db'));
const run = (sql, params = []) => new Promise((resolve, reject) => {
  db.run(sql, params, function(err) {
    err ? reject(err) : resolve(this.changes);
  });
});
const all = (sql, params = []) => new Promise((resolve, reject) => {
  db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows));
});

const towns = [
  { name: 'Mombasa', lat: -4.0435, lon: 39.6682 },
  { name: 'Nairobi', lat: -1.2864, lon: 36.8172 },
  { name: 'Kisumu', lat: -0.0917, lon: 34.7680 },
  { name: 'Nakuru', lat: -0.3031, lon: 36.0800 },
  { name: 'Eldoret', lat: 0.5143, lon: 35.2698 },
  { name: 'Malindi', lat: -3.2192, lon: 40.1169 },
  { name: 'Diani', lat: -4.2796, lon: 39.5946 }
];

async function getForecast(town) {
  try {
    const res = await axios.get('http://api.weatherapi.com/v1/forecast.json', {
      params: { key: weatherKey, q: town.name, days: 2 }
    });

    const tomorrow = res.data.forecast.forecastday[1];
    return {
      date: tomorrow.date,
      icon: `https:${tomorrow.day.condition.icon}`,
      condition: tomorrow.day.condition.text,
      rainChance: tomorrow.day.daily_chance_of_rain,
      avgTemp: tomorrow.day.avgtemp_c,
      maxWind: tomorrow.day.maxwind_kph,
      provider: 'WeatherAPI'
    };
  } catch {
    const res = await axios.get('https://api.open-meteo.com/v1/forecast', {
      params: {
        latitude: town.lat,
        longitude: town.lon,
        timezone: 'Africa/Nairobi',
        daily: 'precipitation_probability_max,temperature_2m_max,temperature_2m_min,wind_speed_10m_max'
      }
    });

    const daily = res.data.daily;
    return {
      date: daily.time[1],
      icon: null,
      condition: 'Forecast available',
      rainChance: daily.precipitation_probability_max[1],
      avgTemp: ((daily.temperature_2m_max[1] + daily.temperature_2m_min[1]) / 2).toFixed(1),
      maxWind: daily.wind_speed_10m_max[1],
      provider: 'Open-Meteo'
    };
  }
}

(async () => {
  let made = 0;

  for (const town of towns) {
    const forecast = await getForecast(town);
    const chance = forecast.rainChance;
    const content = [
      `Forecast for ${town.name}: ${forecast.condition}.`,
      `Chance of rain: ${chance}%.`,
      `Average temperature: ${forecast.avgTemp}C.`,
      `Max wind: ${forecast.maxWind} kph.`,
      `Source: ${forecast.provider}.`
    ].join(' ');

    const id = `weather_${town.name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}_${forecast.date.replace(/-/g, '_')}`;

    await run(
      `INSERT INTO markets
       (id, title, description, content, media_url, media_type, category, country, sideA, sideB, startTime, status)
       VALUES (?, ?, ?, ?, ?, 'image', 'weather', ?, 'YES', 'NO', ?, 'open')
       ON CONFLICT(id) DO UPDATE SET
         title=excluded.title,
         description=excluded.description,
         content=excluded.content,
         media_url=excluded.media_url,
         startTime=excluded.startTime,
         status='open',
         timestamp=CURRENT_TIMESTAMP`,
      [
        id,
        `Will it rain in ${town.name} tomorrow?`,
        content,
        content,
        forecast.icon,
        town.name.toLowerCase(),
        forecast.date
      ]
    );

    made++;
  }

  console.log(`weather markets upserted ${made}`);
  console.table(await all('SELECT category, status, COUNT(*) count FROM markets GROUP BY category, status ORDER BY category, status'));
  db.close();
})().catch((err) => {
  console.error(err.response?.data || err.message);
  db.close();
  process.exit(1);
});
