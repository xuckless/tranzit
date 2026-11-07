package main

// alerttext.go turns Calgary Transit's GTFS-RT alert text into something an app
// can show. Calgary leaves header_text empty, sends description_text as HTML,
// and puts the real effect in a <div data-effect="DETOUR"> marker while the
// protobuf effect field says UNKNOWN_EFFECT.

import (
	"html"
	"regexp"
	"strings"
)

var (
	reDataEffect = regexp.MustCompile(`data-effect="([A-Z_]+)"`)
	reBreak      = regexp.MustCompile(`(?i)<\s*(br|/p|/li|/div|/h[1-6])\s*/?>`)
	reTag        = regexp.MustCompile(`<[^>]*>`)
	reSpaces     = regexp.MustCompile(`[ \t\r\f\v]+`)
	reBlankLines = regexp.MustCompile(`\n\s*\n+`)
)

// alertPlainText strips HTML, decodes entities and tidies whitespace, keeping
// paragraph breaks as single newlines.
func alertPlainText(s string) string {
	s = reBreak.ReplaceAllString(s, "\n")
	s = reTag.ReplaceAllString(s, "")
	s = strings.ReplaceAll(html.UnescapeString(s), "\u00a0", " ")
	s = reSpaces.ReplaceAllString(s, " ")
	lines := strings.Split(s, "\n")
	for i, l := range lines {
		lines[i] = strings.TrimSpace(l)
	}
	s = reBlankLines.ReplaceAllString(strings.Join(lines, "\n"), "\n")
	return strings.TrimSpace(s)
}

// alertEffect prefers the protobuf effect, falling back to Calgary's
// data-effect marker when the field is empty or UNKNOWN_EFFECT.
func alertEffect(effect *string, rawDesc string) *string {
	if effect != nil && *effect != "" && *effect != "UNKNOWN_EFFECT" {
		return effect
	}
	if m := reDataEffect.FindStringSubmatch(rawDesc); m != nil {
		v := m[1]
		return &v
	}
	return effect
}

// effectLabel is a short human label for a GTFS-RT effect enum.
func effectLabel(effect *string) string {
	if effect == nil {
		return "Service alert"
	}
	switch *effect {
	case "NO_SERVICE":
		return "No service"
	case "REDUCED_SERVICE":
		return "Reduced service"
	case "SIGNIFICANT_DELAYS":
		return "Delays"
	case "DETOUR":
		return "Detour"
	case "ADDITIONAL_SERVICE":
		return "Extra service"
	case "MODIFIED_SERVICE":
		return "Service change"
	case "STOP_MOVED":
		return "Stop moved"
	case "ACCESSIBILITY_ISSUE":
		return "Accessibility issue"
	default:
		return "Service alert"
	}
}

// alertHeader returns the feed's header when it has one, otherwise
// "<effect> · Route 3, 15 +2".
func alertHeader(header string, effect *string, routes []string) string {
	if h := strings.TrimSpace(alertPlainText(header)); h != "" {
		return h
	}
	label := effectLabel(effect)
	switch n := len(routes); {
	case n == 0:
		return label
	case n == 1:
		return label + " · Route " + routes[0]
	case n <= 3:
		return label + " · Routes " + strings.Join(routes, ", ")
	default:
		return label + " · Routes " + strings.Join(routes[:3], ", ") + " +" + itoa(n-3)
	}
}

func itoa(n int) string {
	if n < 10 {
		return string(rune('0' + n))
	}
	return itoa(n/10) + string(rune('0'+n%10))
}
