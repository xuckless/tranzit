package main

var congestionLevel = map[int]string{
	0: "UNKNOWN_CONGESTION_LEVEL",
	1: "RUNNING_SMOOTHLY",
	2: "STOP_AND_GO",
	3: "CONGESTION",
	4: "SEVERE_CONGESTION",
}

var occupancyStatus = map[int]string{
	0: "EMPTY",
	1: "MANY_SEATS_AVAILABLE",
	2: "FEW_SEATS_AVAILABLE",
	3: "STANDING_ROOM_ONLY",
	4: "CRUSHED_STANDING_ROOM_ONLY",
	5: "FULL",
	6: "NOT_ACCEPTING_PASSENGERS",
	7: "NO_DATA_AVAILABLE",
	8: "NOT_BOARDABLE",
}

var tripScheduleRel = map[int]string{
	0: "SCHEDULED",
	1: "ADDED",
	2: "UNSCHEDULED",
	3: "CANCELED",
	5: "REPLACEMENT",
	6: "DUPLICATED",
}

var stopScheduleRel = map[int]string{
	0: "SCHEDULED",
	1: "SKIPPED",
	2: "NO_DATA",
	3: "UNSCHEDULED",
}

var alertCause = map[int]string{
	1:  "UNKNOWN_CAUSE",
	2:  "OTHER_CAUSE",
	3:  "TECHNICAL_PROBLEM",
	4:  "STRIKE",
	5:  "DEMONSTRATION",
	6:  "ACCIDENT",
	7:  "HOLIDAY",
	8:  "WEATHER",
	9:  "MAINTENANCE",
	10: "CONSTRUCTION",
	11: "POLICE_ACTIVITY",
	12: "MEDICAL_EMERGENCY",
}

var alertEffect = map[int]string{
	1:  "NO_SERVICE",
	2:  "REDUCED_SERVICE",
	3:  "SIGNIFICANT_DELAYS",
	4:  "DETOUR",
	5:  "ADDITIONAL_SERVICE",
	6:  "MODIFIED_SERVICE",
	7:  "OTHER_EFFECT",
	8:  "UNKNOWN_EFFECT",
	9:  "STOP_MOVED",
	10: "NO_EFFECT",
	11: "ACCESSIBILITY_ISSUE",
}

var alertSeverity = map[int]string{
	1: "UNKNOWN_SEVERITY",
	2: "INFO",
	3: "WARNING",
	4: "SEVERE",
}

func enumStr(m map[int]string, key int, fallback string) string {
	if v, ok := m[key]; ok {
		return v
	}
	return fallback
}
