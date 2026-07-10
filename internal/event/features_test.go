package event

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestFeatureDefaultsFilledOnLoad(t *testing.T) {
	base := t.TempDir()
	st, err := Open(base)
	if err != nil {
		t.Fatal(err)
	}
	oldMeta := Meta{Title: "old party", Host: "the DJ"}
	data, err := json.Marshal(oldMeta)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(st.Dir(), "meta.json"), data, 0o644); err != nil {
		t.Fatal(err)
	}

	reloaded, err := Open(base)
	if err != nil {
		t.Fatal(err)
	}
	if got, want := reloaded.Meta().Features, FeatureDefaults(); !reflect.DeepEqual(got, want) {
		t.Fatalf("features = %#v, want %#v", got, want)
	}
}

func TestSetFeaturePersists(t *testing.T) {
	st, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := st.SetFeature("requests", true); err != nil {
		t.Fatal(err)
	}
	if err := st.SetFeature("videoUploads", true); err != nil {
		t.Fatal(err)
	}
	if err := st.SetFeature("bogus", true); err == nil {
		t.Fatal("SetFeature accepted an unknown key")
	}

	var meta Meta
	data, err := os.ReadFile(filepath.Join(st.Dir(), "meta.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(data, &meta); err != nil {
		t.Fatal(err)
	}
	if !meta.Features["requests"] || !meta.Features["videoUploads"] {
		t.Fatalf("persisted features = %#v, want requests/videoUploads on", meta.Features)
	}

	reloaded, err := Open(filepath.Dir(st.Dir()))
	if err != nil {
		t.Fatal(err)
	}
	if got := reloaded.Meta().Features; !got["requests"] || !got["videoUploads"] || !got["uploads"] || !got["comments"] {
		t.Fatalf("reloaded features = %#v", got)
	}
}

func TestSetLinksPersistsAndValidates(t *testing.T) {
	st, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := st.SetLinks([]Link{
		{Type: "instagram", URL: "https://instagram.com/dj", Label: "DJ <main>"},
		{Type: "venmo", URL: "HTTP://venmo.com/u/dj", Label: ""},
	}); err != nil {
		t.Fatal(err)
	}
	if err := st.SetLinks([]Link{{Type: "website", URL: "javascript:alert(1)", Label: "bad"}}); err == nil {
		t.Fatal("SetLinks accepted a javascript URL")
	}

	var meta Meta
	data, err := os.ReadFile(filepath.Join(st.Dir(), "meta.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(data, &meta); err != nil {
		t.Fatal(err)
	}
	if len(meta.Links) != 2 {
		t.Fatalf("persisted links = %#v, want 2", meta.Links)
	}
	if meta.Links[0].Label != "Instagram" || meta.Links[0].URL != "https://instagram.com/dj" || meta.Links[0].Type != "instagram" {
		t.Fatalf("first persisted link = %#v", meta.Links[0])
	}
	if meta.Links[1].Label != "Venmo" || meta.Links[1].URL != "http://venmo.com/u/dj" {
		t.Fatalf("second persisted link = %#v, want default Venmo label and normalized scheme", meta.Links[1])
	}

	reloaded, err := Open(filepath.Dir(st.Dir()))
	if err != nil {
		t.Fatal(err)
	}
	if got := reloaded.Meta().Links; len(got) != 2 || got[0].Label != "Instagram" {
		t.Fatalf("reloaded links = %#v", got)
	}
}
