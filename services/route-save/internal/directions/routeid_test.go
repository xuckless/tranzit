package directions

import "testing"

func TestCanonicalRouteID_MaxAliases(t *testing.T) {
	cases := map[string]string{
		"MG": "301",
		"MP": "307",
		"MO": "303",
		"MY": "304",
		"MT": "306",
		"mg": "301", // case-insensitive
		"2":  "2",   // ordinary numeric routes pass through
		"22": "22",
		"":   "",
	}
	for in, want := range cases {
		if got := canonicalRouteID(in); got != want {
			t.Errorf("canonicalRouteID(%q) = %q, want %q", in, got, want)
		}
	}
}
