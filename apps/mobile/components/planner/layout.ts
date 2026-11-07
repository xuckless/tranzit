// Side-by-side layout for overlapping timeline blocks. Pure — no react-native.
//
// Greedy interval-graph colouring: sort by start (longer first on ties), put each
// block in the first lane that's free, and give every block in a connected
// overlap cluster the same lane count so widths line up within the cluster.

export type LaneInput = { key: string; startMin: number; endMin: number };
export type LaneAssignment = { lane: number; lanes: number };

/**
 * Assign each block a lane index and the lane count of its overlap cluster.
 * `minSpanMin` is the block's minimum *visual* length in minutes (cards have a
 * min pixel height, so a 5-min event still occupies ~44 min of grid): blocks are
 * treated as at least that long when testing overlap.
 */
export function assignLanes(
    items: LaneInput[],
    minSpanMin = 0,
): Map<string, LaneAssignment> {
    const out = new Map<string, LaneAssignment>();
    const sorted = items
        .map((it) => ({
            key: it.key,
            start: it.startMin,
            end: Math.max(it.endMin, it.startMin + minSpanMin, it.startMin + 1),
        }))
        .sort(
            (a, b) =>
                a.start - b.start || b.end - a.end || (a.key < b.key ? -1 : 1),
        );

    let cluster: string[] = [];
    let laneEnds: number[] = [];
    let clusterEnd = -Infinity;

    const flush = () => {
        for (const k of cluster) {
            const a = out.get(k)!;
            out.set(k, { lane: a.lane, lanes: laneEnds.length });
        }
        cluster = [];
        laneEnds = [];
    };

    for (const it of sorted) {
        if (it.start >= clusterEnd) flush();
        let lane = laneEnds.findIndex((end) => end <= it.start);
        if (lane === -1) {
            lane = laneEnds.length;
            laneEnds.push(it.end);
        } else {
            laneEnds[lane] = it.end;
        }
        out.set(it.key, { lane, lanes: 0 });
        cluster.push(it.key);
        clusterEnd = Math.max(clusterEnd, it.end);
    }
    flush();
    return out;
}
