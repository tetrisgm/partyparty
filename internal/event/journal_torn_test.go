package event

import (
	"os"
	"strings"
	"testing"
)

// A crash mid-append must cost ONE record, not two.
//
// The journal is newline delimited and replayed line by line. When a previous
// append was cut short, the file ends without a newline, and appending straight
// onto it fuses the truncated bytes and the new record into a single line that
// json.Unmarshal rejects. Replay then skips the whole line, so the damaged
// record took the next one with it, and that next one had already been
// acknowledged: a post the wall displayed and the guest watched appear, gone
// after a restart, with nothing logged.
func TestATornJournalLineDoesNotSwallowTheNextPost(t *testing.T) {
	dir := t.TempDir()
	st, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st.AddPost("cid-a", "Ada", ":)", "first post", nil, false); err != nil {
		t.Fatal(err)
	}

	// Simulate the crash: chop the final newline and part of the last record,
	// exactly what a truncated write leaves behind.
	path := dataPath(st.Dir(), "posts.jsonl")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	torn := raw[:len(raw)-6] // drops the trailing newline and a few bytes of JSON
	if err := os.WriteFile(path, torn, 0o644); err != nil {
		t.Fatal(err)
	}
	if torn[len(torn)-1] == '\n' {
		t.Fatal("the fixture did not actually leave a torn line")
	}

	// A new post arrives after the crash and is acknowledged to its guest.
	second, err := st.AddPost("cid-b", "Bo", ":D", "second post", nil, false)
	if err != nil {
		t.Fatal(err)
	}

	// Replay from disk, the way a restart does.
	reopened, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	posts, _, _ := reopened.Feed(0)
	var texts []string
	for _, p := range posts {
		texts = append(texts, p.Text)
	}
	found := false
	for _, p := range posts {
		if p.ID == second.ID {
			found = true
		}
	}
	if !found {
		t.Fatalf("the post written AFTER the torn line was lost on replay; surviving posts: %v", texts)
	}

	// And the torn record itself is still gone, which is expected and fine.
	if strings.Contains(strings.Join(texts, "|"), "first post") {
		t.Log("the torn record happened to survive, which is harmless")
	}
}

// The guard must not disturb an intact journal.
func TestAppendLineLeavesAnIntactJournalAlone(t *testing.T) {
	dir := t.TempDir()
	st, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, text := range []string{"one", "two", "three"} {
		if _, err := st.AddPost("cid", "Ada", ":)", text, nil, false); err != nil {
			t.Fatal(err)
		}
	}
	raw, err := os.ReadFile(dataPath(st.Dir(), "posts.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), "\n\n") {
		t.Fatalf("the torn-line guard inserted a blank line into a healthy journal:\n%s", raw)
	}
	reopened, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	if posts, _, _ := reopened.Feed(0); len(posts) != 3 {
		t.Fatalf("replayed %d posts, want 3", len(posts))
	}
}
