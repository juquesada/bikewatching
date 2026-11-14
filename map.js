import mapboxgl from 'https://cdn.jsdelivr.net/npm/mapbox-gl@2.15.0/+esm';
import * as d3 from 'https://cdn.jsdelivr.net/npm/d3@7.9.0/+esm';

// Step 1: Create the Mapbox map using your public access token.
mapboxgl.accessToken = 'pk.eyJ1IjoianVxdWVzYWRhIiwiYSI6ImNtd2ZubmU3ajA0MWQzMG9tdzI3N2VjOGMifQ.xxIWVyL_PJ45rQ86ihND-w';
const map = new mapboxgl.Map({
  container: 'map',
  style: 'mapbox://styles/mapbox/streets-v12',
  center: [-71.09415, 42.36027],
  zoom: 12,
  minZoom: 5,
  maxZoom: 18,
});
map.addControl(new mapboxgl.NavigationControl());
const svg = d3.select('#map').select('svg');
const status = document.getElementById('status');
let departuresByMinute = Array.from({ length: 1440 }, () => []);
let arrivalsByMinute = Array.from({ length: 1440 }, () => []);
let timeFilter = -1;

function getCoords(station) {
  const point = new mapboxgl.LngLat(+station.lon, +station.lat);
  const { x, y } = map.project(point);
  return { cx: x, cy: y };
}
function formatTime(minutes) {
  return new Date(2024, 2, 1, 0, minutes).toLocaleTimeString('en-US', {
    hour: 'numeric', minute: '2-digit',
  });
}
function minutesSinceMidnight(date) {
  return date.getHours() * 60 + date.getMinutes();
}
// Parse the source's Boston clock times without shifting them to another zone.
const parseTime = d3.timeParse('%Y-%m-%d %H:%M:%S');

// Step 5.4: Read only the relevant minute buckets, wrapping across midnight.
function filterByMinute(tripsByMinute, minute) {
  if (minute === -1) return tripsByMinute.flat();
  const filtered = [];
  for (let offset = -60; offset <= 60; offset++) {
    filtered.push(...tripsByMinute[(minute + offset + 1440) % 1440]);
  }
  return filtered;
}
function computeStationTraffic(stations, minute = -1) {
  const departures = d3.rollup(
    filterByMinute(departuresByMinute, minute),
    v => v.length,
    d => d.start_station_id,
  );
  const arrivals = d3.rollup(
    filterByMinute(arrivalsByMinute, minute),
    v => v.length,
    d => d.end_station_id,
  );
  return stations.map(station => {
    const id = station.short_name;
    return {
      ...station,
      arrivals: arrivals.get(id) ?? 0,
      departures: departures.get(id) ?? 0,
      totalTraffic: (arrivals.get(id) ?? 0) + (departures.get(id) ?? 0),
    };
  });
}
function tooltip(station) {
  return `${station.name}: ${station.totalTraffic.toLocaleString()} trips (${station.departures.toLocaleString()} departures, ${station.arrivals.toLocaleString()} arrivals)`;
}
map.on('error', event => {
  console.error('Map resource error:', event.error);
  status.textContent = 'A map resource failed to load. Check your connection and the browser console.';
});
map.on('load', async () => {
  // Step 2: Add both cities' bike lanes after the map loads.
  const bikeLaneStyle = {
    'line-color': '#32a852',
    'line-width': 3,
    'line-opacity': 0.6,
  };
  map.addSource('boston_route', {
    type: 'geojson',
    data: 'https://bostonopendata-boston.opendata.arcgis.com/datasets/boston::existing-bike-network-2022.geojson',
  });
  map.addLayer({ id: 'boston-bike-lanes', type: 'line', source: 'boston_route', paint: bikeLaneStyle });
  map.addSource('cambridge_route', {
    type: 'geojson',
    data: 'https://raw.githubusercontent.com/cambridgegis/cambridgegis_data/main/Recreation/Bike_Facilities/RECREATION_BikeFacilities.geojson',
  });
  map.addLayer({ id: 'cambridge-bike-lanes', type: 'line', source: 'cambridge_route', paint: bikeLaneStyle });

  try {
    // Steps 3 and 4: Load stations and parse March 2024 trips.
    const [jsonData, trips] = await Promise.all([
      d3.json('https://dsc106.com/labs/lab07/data/bluebikes-stations.json'),
      d3.csv('https://dsc106.com/labs/lab07/data/bluebikes-traffic-2024-03.csv', trip => {
        trip.started_at = parseTime(trip.started_at);
        trip.ended_at = parseTime(trip.ended_at);
        if (trip.started_at) departuresByMinute[minutesSinceMidnight(trip.started_at)].push(trip);
        if (trip.ended_at) arrivalsByMinute[minutesSinceMidnight(trip.ended_at)].push(trip);
        return trip;
      }),
    ]);
    const stations = computeStationTraffic(jsonData.data.stations);
    const radiusScale = d3.scaleSqrt()
      .domain([0, d3.max(stations, d => d.totalTraffic) || 1])
      .range([0, 25]);
    // Step 6: Three discrete categories for the departure / total ratio.
    const stationFlow = d3.scaleQuantize().domain([0, 1]).range([0, 0.5, 1]);
    const circles = svg.selectAll('circle')
      .data(stations, d => d.short_name)
      .join('circle')
      .attr('r', d => radiusScale(d.totalTraffic))
      .style('--departure-ratio', d => stationFlow(d.totalTraffic ? d.departures / d.totalTraffic : 0.5));
    circles.append('title').text(tooltip);

    function updatePositions() {
      circles.each(function (station) {
        const { cx, cy } = getCoords(station);
        d3.select(this).attr('cx', cx).attr('cy', cy);
      });
    }
    updatePositions();
    for (const event of ['move', 'zoom', 'resize', 'moveend']) map.on(event, updatePositions);

    // Step 5: Connect the slider to the time display and traffic overlay.
    const timeSlider = document.getElementById('time-slider');
    const selectedTime = document.getElementById('selected-time');
    const anyTimeLabel = document.getElementById('any-time');
    function updateScatterPlot(minute) {
      const filteredStations = computeStationTraffic(stations, minute);
      radiusScale.range(minute === -1 ? [0, 25] : [3, 50]);
      circles.data(filteredStations, d => d.short_name)
        // Hide zero-traffic stations rather than giving them misleading area.
        .attr('r', d => d.totalTraffic ? radiusScale(d.totalTraffic) : 0)
        .style('--departure-ratio', d => stationFlow(d.totalTraffic ? d.departures / d.totalTraffic : 0.5))
        .select('title').text(tooltip);
    }
    function updateTimeDisplay() {
      timeFilter = Number(timeSlider.value);
      selectedTime.hidden = timeFilter === -1;
      anyTimeLabel.hidden = timeFilter !== -1;
      selectedTime.textContent = timeFilter === -1 ? '' : formatTime(timeFilter);
      if (timeFilter !== -1) selectedTime.dateTime = `${String(Math.floor(timeFilter / 60) % 24).padStart(2, '0')}:${String(timeFilter % 60).padStart(2, '0')}`;
      timeSlider.setAttribute('aria-valuetext', timeFilter === -1 ? 'Any time' : formatTime(timeFilter));
      updateScatterPlot(timeFilter);
    }
    let pendingFrame;
    timeSlider.addEventListener('input', () => {
      cancelAnimationFrame(pendingFrame);
      pendingFrame = requestAnimationFrame(updateTimeDisplay);
    });
    timeSlider.disabled = false;
    updateTimeDisplay();
    status.textContent = `${trips.length.toLocaleString()} rides loaded · ${stations.length} stations`;
  } catch (error) {
    console.error('Error loading Bluebikes data:', error);
    status.textContent = 'Could not load bike data. Check your connection and reload the page.';
  }
});
