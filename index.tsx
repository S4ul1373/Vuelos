import React, { useState, useEffect, useRef, useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import 'https://unpkg.com/leaflet-rotatedmarker@0.2.0/leaflet.rotatedMarker.js';

// --- TYPE DEFINITIONS ---
declare namespace L {
    interface Map {
        setView(center: [number, number], zoom: number): this;
        on(event: string, handler: (e: any) => void): this;
    }
    interface Layer {
        addTo(map: Map | LayerGroup): this;
        bindTooltip(content: string, options?: any): this;
        remove(): this;
    }
    interface Marker extends Layer {
        setLatLng(latlng: [number, number]): this;
        setIcon(any): this;
    }
    interface LayerGroup extends Layer {
        clearLayers(): this;
    }
    interface HeatLayer extends Layer {
        setLatLngs(latlngs: [number, number][]): this;
    }

    function map(id: string, options: any): Map;
    function tileLayer(url: string, options: any): Layer;
    namespace control {
        function zoom(options: any): Layer;
    }
    function layerGroup(): LayerGroup;
    function divIcon(options: any): any;
    function marker(latlng: any, options: any): Marker;
    function circleMarker(latlng: any, options: any): Layer;
    function heatLayer(latlngs: [number, number][], options: any): HeatLayer;
}

type FlightState = [
    string, string | null, string, number, number,
    number | null, number | null, number | null, boolean, number | null,
    number | null, number | null, number[] | null, number | null, string | null,
    boolean, number
];

interface FlightData {
    icao24: string; callsign: string; airline: string; origin_country: string;
    longitude: number; latitude: number; altitude: number;
    velocity: number; true_track: number; vertical_rate: number;
    isLowAltitude: boolean; on_ground: boolean; squawk: string | null;
    last_contact: number; distance_nmi: number; status: string;
}

// --- CONSTANTS ---
const CDMX_BOUNDS = { lamin: 19.0, lomin: -99.9, lamax: 19.8, lomax: -98.5 };
const MAP_CENTER: [number, number] = [19.4326, -99.1332];
const REFRESH_INTERVAL = 120000;
const OPENSKY_API_URL = 'https://opensky-network.org/api/states/all';
const PROXY_URL = 'https://cors.eu.org/';
const LOW_ALTITUDE_THRESHOLD_METERS = 3048; // 10,000 feet
const REQUEST_TIMEOUT = 30000; // 30 seconds

const AIRLINE_DATA_MAP = {
    'AMX': 'Aeroméxico', 'VOI': 'Volaris', 'VIV': 'Viva Aerobus', 'AAL': 'American Airlines',
    'UAL': 'United Airlines', 'DAL': 'Delta Air Lines', 'SWA': 'Southwest Airlines', 'ACA': 'Air Canada',
    'AFR': 'Air France', 'KLM': 'KLM Royal Dutch Airlines', 'IBE': 'Iberia', 'BAW': 'British Airways',
    'DLH': 'Lufthansa', 'AVA': 'Avianca', 'CMP': 'Copa Airlines', 'LAN': 'LATAM Airlines',
    'ANA': 'All Nippon Airways', 'JAL': 'Japan Airlines', 'KAL': 'Korean Air', 'QTR': 'Qatar Airways',
    'THY': 'Turkish Airlines', 'UAE': 'Emirates', 'FDX': 'FedEx Express', 'UPS': 'UPS Airlines',
    'SCX': 'Sun Country Airlines', 'WJA': 'WestJet', 'FFT': 'Frontier Airlines', 'NKS': 'Spirit Airlines',
    'JBU': 'JetBlue Airways', 'ASA': 'Alaska Airlines', 'AAR': 'Asiana Airlines', 'CPA': 'Cathay Pacific',
    'ETH': 'Ethiopian Airlines', 'EZY': 'easyJet', 'FIN': 'Finnair', 'GTI': 'Atlas Air',
    'ICE': 'Icelandair', 'MAS': 'Malaysia Airlines', 'QFA': 'Qantas', 'RYR': 'Ryanair',
    'SAS': 'Scandinavian Airlines', 'SIA': 'Singapore Airlines', 'SWR': 'Swiss', 'TAP': 'TAP Air Portugal',
    'VIR': 'Virgin Atlantic',
};

type SortKey = keyof FlightData | 'altitude_ft' | 'velocity_kt' | 'vertical_rate_fpm';

// --- HELPER FUNCTIONS ---
const getAltitudeColor = (altitudeMeters: number | null) => {
    if (altitudeMeters === null) return 'var(--level-color)';
    const alt_ft = altitudeMeters * 3.28084;
    if (alt_ft <= 2000) return 'var(--alt-level-1)';
    if (alt_ft <= 6000) return 'var(--alt-level-2)';
    if (alt_ft <= 12000) return 'var(--alt-level-3)';
    if (alt_ft <= 20000) return 'var(--alt-level-4)';
    return 'var(--alt-level-5)';
};
const getVerticalRateColor = (verticalRate: number) => {
    if (verticalRate > 1.5) return 'var(--climbing-color)';
    if (verticalRate < -1.5) return 'var(--descending-color)';
    return 'var(--level-color)';
};
const getFlightIcon = (flight: FlightData) => {
    const iconHtml = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" style="transform: rotate(${flight.true_track || 0}deg); fill: ${getAltitudeColor(flight.altitude)}; stroke: #1a202c; stroke-width: 1;">
        <path d="M20.34,9.32l-14-7a1,1,0,0,0-1.34.66L2.29,13.21a1,1,0,0,0,1.34,1.33l3-1.2v3.52L4.5,18v2l8-2.5,8,2.5V18l-2.13-1.14V10.13l3-1.2A1,1,0,0,0,20.34,9.32Z"/>
    </svg>`;
    return L.divIcon({ html: iconHtml, className: '', iconSize: [24, 24], iconAnchor: [12, 12] });
};
const getFlightTooltipContent = (flight: FlightData) => {
    return `
        <div class="tooltip-row"><span>Callsign:</span> <span>${flight.callsign}</span></div>
        <div class="tooltip-row"><span>Airline:</span> <span>${flight.airline}</span></div>
        <div class="tooltip-row"><span>Status:</span> <span>${flight.status}</span></div>
        <div class="tooltip-row"><span>Origin:</span> <span>${flight.origin_country}</span></div>
    `;
};
const haversineDistance = (coords1: [number, number], coords2: [number, number]): number => {
    const toRad = (x: number) => x * Math.PI / 180;
    const R = 3440.065; // Earth radius in nautical miles
    const dLat = toRad(coords2[0] - coords1[0]);
    const dLon = toRad(coords2[1] - coords1[1]);
    const lat1 = toRad(coords1[0]);
    const lat2 = toRad(coords2[0]);
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.sin(dLon / 2) * Math.sin(dLon / 2) * Math.cos(lat1) * Math.cos(lat2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
};

// --- UI COMPONENTS ---
const StatusBar: React.FC<{ status: string; lastUpdated: Date | null; countdown: number; error: string | null }> = ({ status, lastUpdated, countdown, error }) => {
    const statusText = { idle: 'Idle', loading: 'Loading...', success: 'Live', error: error || 'Error' }[status] || 'Unknown';
    const statusClass = { idle: '', loading: 'loading', success: 'live', error: 'error' }[status] || '';

    return (
        <div className="status-bar">
            <div className="status-header">
                <div className={`status-indicator ${statusClass}`}>{statusText}</div>
                <div className="countdown">Next refresh: {Math.round(countdown)}s</div>
            </div>
            <div className="last-updated">
                {lastUpdated ? `Last updated: ${lastUpdated.toLocaleTimeString()}` : 'Fetching data...'}
            </div>
        </div>
    );
};

const StatisticsPanel: React.FC<{ flights: FlightData[] }> = ({ flights }) => {
    const [isOpen, setIsOpen] = useState(true);

    const airlineStats = useMemo(() => {
        const stats = flights.reduce((acc, flight) => {
            const airline = flight.airline;
            acc[airline] = (acc[airline] || 0) + 1;
            return acc;
        }, {} as { [key: string]: number });
        
        return Object.entries(stats).sort((a, b) => b[1] - a[1]);
    }, [flights]);

    return (
        <div>
            <button className={`stats-toggle ${isOpen ? 'open' : ''}`} onClick={() => setIsOpen(!isOpen)}>
                <span>Análisis de Tráfico</span>
                <span className="arrow">▶</span>
            </button>
            <div className={`stats-panel ${isOpen ? 'open' : ''}`}>
                <ul className="stats-list">
                    {airlineStats.map(([airline, count]) => (
                         <li key={airline}>
                            <span>{airline}</span>
                            <span className="count">{count}</span>
                        </li>
                    ))}
                </ul>
            </div>
        </div>
    );
};

const FlightTable: React.FC<{
    flights: FlightData[];
    selectedFlight: string | null;
    onFlightSelect: (flight: FlightData | null) => void;
}> = ({ flights, selectedFlight, onFlightSelect }) => {

    const [sortConfig, setSortConfig] = useState<{ key: SortKey; direction: 'asc' | 'desc' }>({ key: 'callsign', direction: 'asc' });

    const sortedFlights = useMemo(() => {
        let sortableFlights = [...flights];
        sortableFlights.sort((a, b) => {
            const getVal = (flight: FlightData, key: SortKey) => {
                if (key === 'altitude_ft') return flight.altitude ? Math.round(flight.altitude * 3.28084) : -1;
                if (key === 'velocity_kt') return flight.velocity ? Math.round(flight.velocity * 1.94384) : -1;
                if (key === 'vertical_rate_fpm') return flight.vertical_rate ? Math.abs(Math.round(flight.vertical_rate * 196.85)) : -1;
                const val = flight[key as keyof FlightData];
                return typeof val === 'string' ? val.toLowerCase() : val ?? -1;
            };
            const valA = getVal(a, sortConfig.key);
            const valB = getVal(b, sortConfig.key);
            if (valA < valB) return sortConfig.direction === 'asc' ? -1 : 1;
            if (valA > valB) return sortConfig.direction === 'asc' ? 1 : -1;
            return 0;
        });
        return sortableFlights;
    }, [flights, sortConfig]);
    
    const requestSort = (key: SortKey) => {
        let direction: 'asc' | 'desc' = 'asc';
        if (sortConfig.key === key && sortConfig.direction === 'asc') {
            direction = 'desc';
        }
        setSortConfig({ key, direction });
    };

    const getSortIndicator = (key: SortKey) => {
        if (sortConfig.key !== key) return null;
        return sortConfig.direction === 'asc' ? ' ▲' : ' ▼';
    };
    
    const headers: { key: SortKey; label: string; width?: string }[] = [
        { key: 'callsign', label: 'Callsign' }, { key: 'airline', label: 'Airline' },
        { key: 'icao24', label: 'Hex ID' }, { key: 'origin_country', label: 'País Origen' },
        { key: 'squawk', label: 'Squawk' }, { key: 'status', label: 'Estado' },
        { key: 'altitude_ft', label: 'Altitud' }, { key: 'velocity_kt', label: 'Velocidad' },
        { key: 'vertical_rate_fpm', label: 'V. Rate (ft/min)' }, { key: 'distance_nmi', label: 'Dist (nmi)' },
        { key: 'true_track', label: 'Track' }, { key: 'last_contact', label: 'Visto' }
    ];

    return (
        <table className="flight-table">
            <thead style={{ position: 'sticky', top: 0, backgroundColor: 'var(--table-header-bg)' }}>
                <tr>
                    {headers.map(({ key, label }) => (
                        <th key={key} onClick={() => requestSort(key)}>
                            {label}{getSortIndicator(key)}
                        </th>
                    ))}
                </tr>
            </thead>
            <tbody>
                {sortedFlights.map((flight, index) => (
                    <tr key={flight.icao24}
                        className={selectedFlight === flight.icao24 ? 'selected-row' : ''}
                        style={{ backgroundColor: index % 2 === 0 ? 'var(--table-row-even-bg)' : 'var(--table-row-odd-bg)', cursor: 'pointer' }}
                        onClick={() => onFlightSelect(selectedFlight === flight.icao24 ? null : flight)}
                    >
                        <td style={{ fontWeight: 'bold' }}>{flight.callsign || 'N/A'}</td>
                        <td>{flight.airline}</td>
                        <td>{flight.icao24}</td>
                        <td>{flight.origin_country}</td>
                        <td>{flight.squawk || '----'}</td>
                        <td>{flight.status}</td>
                        <td>
                           {flight.isLowAltitude && <span className="low-altitude-warning" title="Low Altitude">⚠️</span>}
                           {flight.altitude ? Math.round(flight.altitude * 3.28084) : '---'} ft
                           <span className="unit-secondary">{flight.altitude ? Math.round(flight.altitude) : ''} m</span>
                        </td>
                        <td>
                           {flight.velocity ? Math.round(flight.velocity * 1.94384) : '---'} kt
                           <span className="unit-secondary">{flight.velocity ? Math.round(flight.velocity * 3.6) : ''} km/h</span>
                        </td>
                        <td style={{ color: getVerticalRateColor(flight.vertical_rate) }}>
                            {flight.vertical_rate > 0.5 ? '▲' : flight.vertical_rate < -0.5 ? '▼' : '▬'} {Math.abs(Math.round(flight.vertical_rate * 196.85))}
                        </td>
                        <td>{flight.distance_nmi.toFixed(1)}</td>
                        <td>{flight.true_track ? Math.round(flight.true_track) : '---'}°</td>
                        <td>{Math.round(Date.now()/1000 - flight.last_contact)}s ago</td>
                    </tr>
                ))}
            </tbody>
        </table>
    );
};

// --- MAIN APP COMPONENT ---
const App: React.FC = () => {
    const [flights, setFlights] = useState<FlightData[]>([]);
    const [selectedFlight, setSelectedFlight] = useState<FlightData | null>(null);
    const [fetchStatus, setFetchStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
    const [errorMessage, setErrorMessage] = useState<string | null>(null);
    const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
    const [countdown, setCountdown] = useState(REFRESH_INTERVAL / 1000);
    const [isHeatmapVisible, setIsHeatmapVisible] = useState(false);
    
    const mapRef = useRef<L.Map | null>(null);
    const flightMarkersRef = useRef<{ [key: string]: L.Marker }>({});
    const selectionHighlightLayerRef = useRef<L.LayerGroup | null>(null);
    const heatLayerRef = useRef<L.HeatLayer | null>(null);

    // Effect for initializing map
    useEffect(() => {
        if (!mapRef.current) {
            const map = L.map('map', { center: MAP_CENTER, zoom: 9, zoomControl: false });
            L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
                attribution: '&copy; OpenStreetMap &copy; CARTO', maxZoom: 20
            }).addTo(map);
            L.control.zoom({ position: 'bottomright' }).addTo(map);
            
            selectionHighlightLayerRef.current = L.layerGroup().addTo(map);
            heatLayerRef.current = L.heatLayer([], {
                radius: 30, blur: 20, maxZoom: 12,
                gradient: { 0.4: 'blue', 0.65: '#38b2ac', 1: 'red' }
            });

            map.on('click', () => setSelectedFlight(null));
            mapRef.current = map;
        }
    }, []);

    // Effect for fetching flights
    useEffect(() => {
        const fetchFlights = async () => {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
            setFetchStatus('loading');
            try {
                const targetUrl = `${OPENSKY_API_URL}?lamin=${CDMX_BOUNDS.lamin}&lomin=${CDMX_BOUNDS.lomin}&lamax=${CDMX_BOUNDS.lamax}&lomax=${CDMX_BOUNDS.lomax}`;
                const url = `${PROXY_URL}${targetUrl}`;
                const response = await fetch(url, { signal: controller.signal });
                clearTimeout(timeoutId);
                if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
                const data = await response.json();
                
                const flightData: FlightData[] = (data.states || [])
                    .filter((s: FlightState) => s[5] && s[6] && s[1])
                    .map((s: FlightState) => {
                        const callsign = (s[1] || 'N/A').trim();
                        const icaoPrefix = callsign.substring(0, 3).toUpperCase();
                        const airline = AIRLINE_DATA_MAP[icaoPrefix as keyof typeof AIRLINE_DATA_MAP] || 'Private/Unknown';
                        const altitude = s[7] as number | null;
                        const vertical_rate = s[11] as number || 0;
                        const on_ground = s[8] as boolean;
                        let status = "Crucero";
                        if (on_ground) status = "En Tierra";
                        else if (vertical_rate > 0.5) status = "Ascendiendo";
                        else if (vertical_rate < -0.5) status = "Descendiendo";

                        return {
                            icao24: s[0], callsign: callsign, airline: airline, origin_country: s[2],
                            longitude: s[5] as number, latitude: s[6] as number, altitude: altitude,
                            velocity: s[9] as number, true_track: s[10] as number, vertical_rate: vertical_rate,
                            isLowAltitude: altitude !== null && altitude < LOW_ALTITUDE_THRESHOLD_METERS,
                            on_ground: on_ground, squawk: s[14] as string | null, last_contact: s[4],
                            distance_nmi: haversineDistance([s[6] as number, s[5] as number], MAP_CENTER),
                            status: status
                        };
                    });

                setFlights(flightData);
                setFetchStatus('success');
                setLastUpdated(new Date());
                setErrorMessage(null);
            } catch (error: any) {
                clearTimeout(timeoutId);
                console.error('Failed to fetch flight data:', error.message);
                if (error.message.includes('429')) setErrorMessage('Rate Limited. Retrying...');
                else if (error.name === 'AbortError') setErrorMessage(`Request Timed Out (${REQUEST_TIMEOUT/1000}s). Retrying...`);
                else if (error instanceof TypeError) setErrorMessage('Network Error (Proxy). Retrying...');
                else setErrorMessage(error.message || 'Unknown fetch error');
                setFetchStatus('error');
            }
        };

        const fetchInterval = setInterval(fetchFlights, REFRESH_INTERVAL);
        const countdownInterval = setInterval(() => {
            setCountdown(prev => (prev > 1 ? prev - 1 : REFRESH_INTERVAL / 1000));
        }, 1000);

        setTimeout(fetchFlights, 1000); // Initial fetch after a brief delay

        return () => { clearInterval(fetchInterval); clearInterval(countdownInterval); };
    }, []);

    // Effect for updating map markers and heatmap
    useEffect(() => {
        if (!mapRef.current) return;
        
        const currentMarkers = flightMarkersRef.current;
        const newIcaos = new Set(flights.map(f => f.icao24));

        Object.keys(currentMarkers).forEach(icao => {
            if (!newIcaos.has(icao)) {
                currentMarkers[icao].remove();
                delete currentMarkers[icao];
            }
        });

        const heatPoints: [number, number][] = [];

        flights.forEach(flight => {
            const latLng: [number, number] = [flight.latitude, flight.longitude];
            heatPoints.push(latLng);

            const icon = getFlightIcon(flight);
            const tooltip = getFlightTooltipContent(flight);

            if (currentMarkers[flight.icao24]) {
                const marker = currentMarkers[flight.icao24];
                marker.setLatLng(latLng);
                marker.setIcon(icon);
                (marker as any).setRotationAngle?.(flight.true_track || 0);
                marker.bindTooltip(tooltip, { permanent: false, direction: 'top', offset: [0, -10] });
            } else {
                const marker = L.marker(latLng, {
                    icon: icon,
                    rotationAngle: flight.true_track || 0,
                } as any).addTo(mapRef.current!);
                
                marker.bindTooltip(tooltip, { permanent: false, direction: 'top', offset: [0, -10] });
                currentMarkers[flight.icao24] = marker;
            }
        });

        if (heatLayerRef.current) {
            heatLayerRef.current.setLatLngs(heatPoints);
        }
    }, [flights]);

    // Effect for handling selected flight highlight
    useEffect(() => {
        if (!mapRef.current || !selectionHighlightLayerRef.current) return;

        selectionHighlightLayerRef.current.clearLayers();

        if (selectedFlight) {
            const flightData = flights.find(f => f.icao24 === selectedFlight.icao24);
            if (flightData) {
                const latLng: [number, number] = [flightData.latitude, flightData.longitude];
                mapRef.current.setView(latLng, 11);
                L.circleMarker(latLng, {
                    radius: 20,
                    className: 'selection-marker'
                }).addTo(selectionHighlightLayerRef.current);
            }
        }
    }, [selectedFlight, flights]);

    // Effect for toggling heatmap visibility
    useEffect(() => {
        if (!mapRef.current || !heatLayerRef.current) return;
        if (isHeatmapVisible) {
            heatLayerRef.current.addTo(mapRef.current);
        } else {
            heatLayerRef.current.remove();
        }
    }, [isHeatmapVisible]);
    
    return (
        <>
            <div id="map" style={{ width: '70vw', height: '100vh' }}>
                 <button 
                    className={`heatmap-toggle-button ${isHeatmapVisible ? 'active' : ''}`}
                    onClick={() => setIsHeatmapVisible(!isHeatmapVisible)}
                    title="Toggle Heatmap"
                >
                    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14.5 4.5c3 3 3 7.5 0 10.5-3 3-7.5 3-10.5 0s-3-7.5 0-10.5c3-3 7.5-3 10.5 0z"/><path d="M12 12c-1-2-1-4 0-6"/><path d="M12 12c1 2 1 4 0 6"/></svg>
                </button>
            </div>
            <div className="sidebar">
                <StatusBar status={fetchStatus} lastUpdated={lastUpdated} countdown={countdown} error={errorMessage} />
                <StatisticsPanel flights={flights} />
                <div className="sidebar-content">
                    <FlightTable 
                        flights={flights} 
                        selectedFlight={selectedFlight?.icao24 || null} 
                        onFlightSelect={setSelectedFlight} 
                    />
                </div>
            </div>
        </>
    );
};

const container = document.getElementById('root');
if (container) {
    const root = createRoot(container);
    root.render(<App />);
}