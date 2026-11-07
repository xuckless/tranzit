package main

import "testing"

func TestAlertText(t *testing.T) {
	raw := `<div data-effect="DETOUR"></div><p><b>Nov 9 &ndash; Dec 3:</b> Route 13 detours via 4 St&nbsp;SW.</p><p>Use stop 5432.</p>`
	if got, want := alertPlainText(raw), "Nov 9 – Dec 3: Route 13 detours via 4 St SW.\nUse stop 5432."; got != want {
		t.Fatalf("plain text:\n got %q\nwant %q", got, want)
	}
	unknown := "UNKNOWN_EFFECT"
	eff := alertEffect(&unknown, raw)
	if eff == nil || *eff != "DETOUR" {
		t.Fatalf("effect = %v, want DETOUR", eff)
	}
	if got := alertHeader("", eff, []string{"13"}); got != "Detour · Route 13" {
		t.Fatalf("header = %q", got)
	}
	if got := alertHeader("", eff, []string{"1", "2", "3", "4", "5"}); got != "Detour · Routes 1, 2, 3 +2" {
		t.Fatalf("header = %q", got)
	}
	if got := alertHeader("Bridge closed", eff, nil); got != "Bridge closed" {
		t.Fatalf("header = %q", got)
	}
	if got := itoa(42); got != "42" {
		t.Fatalf("itoa = %q", got)
	}
}
