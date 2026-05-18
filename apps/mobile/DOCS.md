# Calgary Transit Places Search API Documentation

## 1. Client GET Request (`/search`)

**Endpoint:** `GET /search`
**Query Parameters:**

* `q` (Required): The text string the user is searching for (e.g., `?q=Calgary Tower`).

### **Request Example**

```http
GET http://localhost:3100/search?q=Calgary+Tower

```

---

## 2. Response JSON Schema

The API returns a `200 OK` with an array of matching places. Because we are using a restricted `FieldMask` to save costs, the response only includes the exact fields required for routing and UI display.

If no locations match the query, it returns `404 Not Found`.

```json
{
  "places": [
    {
      "id": "string (The Google Place ID, required for the /route endpoint)",
      "displayName": {
        "text": "string (The human-readable name of the location)"
      },
      "location": {
        "latitude": "float",
        "longitude": "float"
      }
    }
  ]
}

```

---

## 3. What NOT To Do

* **DO NOT pass the `displayName.text` to the `/route` endpoint.** The routing engine strictly requires the `id` (Place ID).
* **DO NOT cache Place IDs indefinitely.** Google's terms of service require Place IDs to be refreshed periodically, and they can occasionally change. Only store them in the user's active session state.
* **DO NOT ignore the coordinates.** While the Route API uses the Place ID, you should use the `location.latitude` and `location.longitude` returned here to immediately drop a "Destination" pin on your React Native map while the Route API is still loading in the background.

---

## 4. How to Chain Search to Routing (React Native)

Here is a standard pattern for taking user input, fetching the Place ID, and immediately passing it to your transit routing function.

```javascript
import React, { useState } from 'react';
import { View, TextInput, Button, Alert } from 'react-native';

const TransitSearch = ({ userCurrentLocation, onRouteFound }) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const handleSearchAndRoute = async () => {
    if (!searchQuery) return;
    setIsLoading(true);

    try {
      // 1. Fetch the Place ID
      const searchRes = await fetch(`http://localhost:3100/search?q=${encodeURIComponent(searchQuery)}`);
      
      if (searchRes.status === 404) {
        Alert.alert("Error", "Location not found.");
        setIsLoading(false);
        return;
      }

      const searchData = await searchRes.json();
      const placeId = searchData.places[0].id; // Grab the top result

      // 2. Pass the Place ID and Current Location to the Routes API
      const routeRes = await fetch('http://localhost:3100/route', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          origin: userCurrentLocation, // e.g., { lat: 51.0447, lng: -114.0719 }
          destination_id: placeId
        })
      });

      if (routeRes.status === 204) {
        Alert.alert("No Transit", "No public transit routes found for this destination.");
      } else {
        const routeData = await routeRes.json();
        onRouteFound(routeData.routes); // Pass best routes up to the Map component
      }

    } catch (error) {
      Alert.alert("Network Error", "Could not connect to the server.");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <View style={{ padding: 10 }}>
      <TextInput
        placeholder="Where to?"
        value={searchQuery}
        onChangeText={setSearchQuery}
        style={{ borderWidth: 1, padding: 10, marginBottom: 10 }}
      />
      <Button 
        title={isLoading ? "Calculating..." : "Find Route"} 
        onPress={handleSearchAndRoute} 
        disabled={isLoading} 
      />
    </View>
  );
};

export default TransitSearch;

```

# Calgary Transit Routing API Documentation

## 1. Client POST Request (`/route`)

**Endpoint:** `POST /route`
**Headers:** `Content-Type: application/json`

The client must send the user's current exact GPS coordinates and the Google Place ID of the destination.

### **Request Body**

```json
{
  "origin": {
    "lat": 51.0447,
    "lng": -114.0719
  },
  "destination_id": "ChIJJzJsi_1vcVMRgZd7NwckWfE"
}

```

---

## 2. Response JSON Schema

The API returns a `200 OK` with an array of the **top 2 best transit routes** sorted by shortest duration. If no transit routes are found, it returns `204 No Content`.

```json
{
  "routes": [
    {
      "distanceMeters": "integer (total distance in meters)",
      "duration": "string (e.g., '442s')",
      "polyline": {
        "encodedPolyline": "string (ASCII compressed vector)"
      },
      "legs": [
        {
          "steps": [
            {
              "travelMode": "string (WALK | TRANSIT)",
              "navigationInstruction": {
                "instructions": "string (Turn-by-turn text)",
                "maneuver": "string (e.g., DEPART, TURN_LEFT)"
              },
              "transitDetails": {
                "headsign": "string (Destination displayed on bus)",
                "stopCount": "integer",
                "transitLine": {
                  "name": "string (e.g., Richmond Rd SW)",
                  "nameShort": "string (Bus Number, e.g., '22')",
                  "vehicle": {
                    "type": "string (BUS | TRAM | TRAIN)",
                    "name": { "text": "string" },
                    "iconUri": "string (URL to Google's transit icon)"
                  },
                  "agencies": [
                    { "name": "string", "phoneNumber": "string", "uri": "string" }
                  ]
                },
                "stopDetails": {
                  "departureStop": { "name": "string", "location": { "latLng": { "latitude": "float", "longitude": "float" } } },
                  "departureTime": "string (ISO-8601)",
                  "arrivalStop": { "name": "string", "location": { "latLng": { "latitude": "float", "longitude": "float" } } },
                  "arrivalTime": "string (ISO-8601)"
                },
                "localizedValues": {
                  "departureTime": { "time": { "text": "string (e.g., '2:57 PM')" }, "timeZone": "string" },
                  "arrivalTime": { "time": { "text": "string" }, "timeZone": "string" }
                }
              }
            }
          ]
        }
      ]
    }
  ]
}

```

---

## 3. What NOT To Do

* **DO NOT send raw text addresses to `/route`.** The `destination_id` must strictly be a Place ID retrieved from the `/search` endpoint.
* **DO NOT chain `/search` if you already have coordinates.** If the user clicks on a map point rather than typing a search, modify the backend to accept raw destination coordinates instead of forcing a Place ID lookup to save API costs.
* **DO NOT decode polylines on the Go backend.** Sending raw coordinate arrays `[[lat, lng], [lat, lng]]` over the network drastically increases payload size and latency. Keep them encoded until they reach the client.
* **DO NOT ignore the `204 No Content` status code.** Always check the HTTP status on the client before parsing JSON. The API will return `204` (with no body) if it is impossible to reach the destination via public transit.

---

## 4. How to Decode the Polyline (React Native)

To render the `encodedPolyline` string on your map, you must decode it into an array of latitude/longitude objects. Use the standard `@mapbox/polyline` library.

**Installation:**

```bash
npm install @mapbox/polyline

```

**React Native Implementation:**

```javascript
import React, { useState, useEffect } from 'react';
import MapView, { Polyline } from 'react-native-maps';
import polyline from '@mapbox/polyline';

const TransitMap = ({ encodedPolylineString }) => {
  const [coordinates, setCoordinates] = useState([]);

  useEffect(() => {
    if (encodedPolylineString) {
      // 1. Decode the ASCII string into an array of [lat, lng] arrays
      const decodedArray = polyline.decode(encodedPolylineString);
      
      // 2. Map it to the {latitude, longitude} object array required by react-native-maps
      const latLngObjects = decodedArray.map((point) => ({
        latitude: point[0],
        longitude: point[1],
      }));

      setCoordinates(latLngObjects);
    }
  }, [encodedPolylineString]);

  return (
    <MapView style={{ flex: 1 }}>
      {coordinates.length > 0 && (
        <Polyline
          coordinates={coordinates}
          strokeColor="#007AFF" // iOS Blue
          strokeWidth={4}
        />
      )}
    </MapView>
  );
};

export default TransitMap;

```
