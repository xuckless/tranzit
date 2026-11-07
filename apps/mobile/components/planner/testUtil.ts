// Shared fixture for the planner unit tests (pure — no react-native).
import { isoForDay, type PlannedEvent } from "./trip";

/** A local-time event on `day` starting at `startMin` for `durMin` minutes. */
export function makeEvent(
    day: string,
    startMin: number,
    durMin: number,
    over: Partial<PlannedEvent> = {},
): PlannedEvent {
    const start = isoForDay(day, startMin);
    return {
        eventId: "x",
        name: "n",
        location: null,
        locationLat: null,
        locationLng: null,
        placeId: null,
        notes: null,
        start,
        end: new Date(new Date(start).getTime() + durMin * 60000).toISOString(),
        timezone: null,
        travelTime: null,
        recurrenceRule: null,
        pending: false,
        imported: false,
        ...over,
    };
}
