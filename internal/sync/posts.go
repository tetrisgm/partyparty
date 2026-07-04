// Package postsync mirrors locally collected event posts and media to the
// broker's online event wall.
package postsync

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"partyparty/internal/event"
	"partyparty/internal/publish"
)

const (
	stateName           = "sync-state.json"
	maxPostsPerBatch    = 200
	maxCommentsPerBatch = 2000
	maxPostJSONBytes    = 900_000
)

var (
	MultipartThreshold   int64 = 8 << 20
	MultipartPartSize    int64 = 8 << 20
	MultipartConcurrency       = 2
)

// Result summarizes a sync attempt. Network/offline failures are reported in
// the result with Offline=true and no error so callers can treat sync as best
// effort.
type Result struct {
	Slug          string `json:"slug"`
	PostsTotal    int    `json:"postsTotal"`
	PostsPushed   int    `json:"postsPushed"`
	PostsSkipped  int    `json:"postsSkipped"`
	MediaTotal    int    `json:"mediaTotal"`
	MediaPushed   int    `json:"mediaPushed"`
	MediaSkipped  int    `json:"mediaSkipped"`
	MediaMissing  int    `json:"mediaMissing,omitempty"`
	MediaDeferred int    `json:"mediaDeferred,omitempty"`
	Offline       bool   `json:"offline,omitempty"`
	LastError     string `json:"lastError,omitempty"`
}

// Backlog summarizes local data not yet acked in sync-state.json.
type Backlog struct {
	PostsPending   int
	MediaPending   int
	MediaMissing   int
	UploadsPending int
}

func (b Backlog) Empty() bool {
	return b.PostsPending == 0 && b.MediaPending == 0
}

type stateFile struct {
	Version   int                            `json:"version"`
	Slug      string                         `json:"slug"`
	InstallID string                         `json:"installId"`
	Posts     map[string]postAck             `json:"posts"`
	Media     map[string]mediaAck            `json:"media"`
	Uploads   map[string]mediaUploadProgress `json:"uploads,omitempty"`
	UpdatedMS int64                          `json:"updatedMs"`
}

type postAck struct {
	Hash    string `json:"hash"`
	AckedMS int64  `json:"ackedMs"`
}

type mediaAck struct {
	CloudID string `json:"cloudId"`
	AckedMS int64  `json:"ackedMs"`
}

type mediaUploadProgress struct {
	CloudID   string                  `json:"cloudId"`
	UploadID  string                  `json:"uploadId"`
	Size      int64                   `json:"size"`
	PartSize  int64                   `json:"partSize"`
	Done      map[string]uploadedPart `json:"done"`
	UpdatedMS int64                   `json:"updatedMs"`
}

type uploadedPart struct {
	ETag    string `json:"etag"`
	Size    int64  `json:"size"`
	AckedMS int64  `json:"ackedMs"`
}

type Options struct {
	DeferLargeMedia bool
}

type journalLine struct {
	Op      string         `json:"op"`
	ID      string         `json:"id,omitempty"`
	CID     string         `json:"cid,omitempty"`
	Post    *event.Post    `json:"post,omitempty"`
	Comment *event.Comment `json:"comment,omitempty"`
	On      bool           `json:"on,omitempty"`
}

type cloudPost struct {
	LocalID   string         `json:"localId"`
	TS        int64          `json:"ts"`
	Author    string         `json:"author"`
	Emoji     string         `json:"emoji,omitempty"`
	Text      string         `json:"text,omitempty"`
	CIDHash   string         `json:"cidHash,omitempty"`
	DJ        bool           `json:"dj,omitempty"`
	NoPublish bool           `json:"noPublish,omitempty"`
	Deleted   bool           `json:"deleted,omitempty"`
	Media     []cloudMedia   `json:"media,omitempty"`
	Comments  []cloudComment `json:"comments"`
}

type cloudComment struct {
	LocalID string `json:"localId"`
	TS      int64  `json:"ts"`
	Author  string `json:"author"`
	Emoji   string `json:"emoji,omitempty"`
	Text    string `json:"text,omitempty"`
	DJ      bool   `json:"dj,omitempty"`
}

type cloudMedia struct {
	LocalID string `json:"localId"`
	Type    string `json:"type"`
	Name    string `json:"name,omitempty"`
	Size    int64  `json:"size,omitempty"`
}

type syncPost struct {
	post  event.Post
	cloud cloudPost
	hash  string
	media []mediaItem
}

type mediaItem struct {
	postLocalID string
	localID     string
	cloudID     string
	path        string
	typ         string
	mime        string
	name        string
	sort        int
	size        int64
}

var httpClient = &http.Client{Timeout: 5 * time.Minute}

// PendingBacklog reads the event journal and sync-state.json and reports
// whether SyncPosts still has work to do. It performs no network I/O.
func PendingBacklog(eventDir string, creds publish.Creds, slug string) (Backlog, error) {
	slug = strings.TrimSpace(slug)
	if creds.ID == "" || creds.Secret == "" || slug == "" {
		return Backlog{}, nil
	}
	posts, err := readPosts(eventDir)
	if err != nil {
		return Backlog{}, err
	}
	if len(posts) == 0 {
		return Backlog{}, nil
	}
	st, err := loadState(eventDir, slug, creds.ID)
	if err != nil {
		return Backlog{}, err
	}
	var b Backlog
	for _, p := range posts {
		if ack, ok := st.Posts[p.cloud.LocalID]; !ok || ack.Hash != p.hash {
			b.PostsPending++
		}
		if p.post.Deleted || p.post.NoPublish {
			continue
		}
		for _, m := range p.media {
			key := mediaStateKey(m.postLocalID, m.localID)
			if _, ok := st.Media[key]; ok {
				continue
			}
			if _, err := os.Stat(m.path); err != nil {
				if os.IsNotExist(err) {
					b.MediaMissing++
					continue
				}
				return Backlog{}, err
			}
			b.MediaPending++
		}
	}
	for key := range st.Uploads {
		if _, ok := st.Media[key]; !ok {
			b.UploadsPending++
		}
	}
	return b, nil
}

// SyncPosts reads posts.jsonl and media files from eventDir, publishes post
// metadata first, then publishes each referenced media file.
func SyncPosts(ctx context.Context, eventDir string, creds publish.Creds, slug, base string) (Result, error) {
	return SyncPostsWithOptions(ctx, eventDir, creds, slug, base, Options{})
}

// SyncPostsWithOptions reads posts.jsonl and media files from eventDir,
// publishes post metadata first, then publishes each referenced media file.
func SyncPostsWithOptions(ctx context.Context, eventDir string, creds publish.Creds, slug, base string, opts Options) (Result, error) {
	var res Result
	slug = strings.TrimSpace(slug)
	res.Slug = slug
	if creds.ID == "" || creds.Secret == "" {
		return res, errors.New("this Mac isn't registered yet - go live once first")
	}
	if slug == "" {
		return res, errors.New("missing event slug")
	}
	if base == "" {
		base = "https://party.ramine.net"
	}
	base = strings.TrimRight(base, "/")

	posts, err := readPosts(eventDir)
	if err != nil {
		return res, err
	}
	res.PostsTotal = len(posts)
	for i := range posts {
		res.MediaTotal += len(posts[i].media)
	}
	if len(posts) == 0 {
		return res, nil
	}

	st, err := loadState(eventDir, slug, creds.ID)
	if err != nil {
		return res, err
	}

	var dirty []syncPost
	for _, p := range posts {
		if ack, ok := st.Posts[p.cloud.LocalID]; ok && ack.Hash == p.hash {
			res.PostsSkipped++
			continue
		}
		dirty = append(dirty, p)
	}

	for _, batch := range postBatches(dirty) {
		if len(batch) == 0 {
			continue
		}
		payloadPosts := make([]cloudPost, 0, len(batch))
		for _, p := range batch {
			payloadPosts = append(payloadPosts, p.cloud)
		}
		offline, err := withRetry(ctx, func() error {
			return postPosts(ctx, base, creds, slug, payloadPosts)
		})
		if err != nil {
			return res, err
		}
		if offline {
			res.Offline = true
			res.LastError = "network unavailable while publishing posts"
			return res, nil
		}
		now := time.Now().UnixMilli()
		for _, p := range batch {
			st.Posts[p.cloud.LocalID] = postAck{Hash: p.hash, AckedMS: now}
			res.PostsPushed++
		}
		if err := saveState(eventDir, st); err != nil {
			return res, err
		}
	}

	for _, p := range posts {
		if p.post.Deleted || p.post.NoPublish {
			continue
		}
		postID := cloudPostID(slug, creds.ID, p.cloud.LocalID)
		for _, m := range p.media {
			key := mediaStateKey(m.postLocalID, m.localID)
			if _, ok := st.Media[key]; ok {
				res.MediaSkipped++
				continue
			}
			info, err := os.Stat(m.path)
			if err != nil {
				if os.IsNotExist(err) {
					res.MediaMissing++
					continue
				}
				return res, err
			}
			m.size = info.Size()
			if opts.DeferLargeMedia && m.size >= MultipartThreshold {
				res.MediaDeferred++
				continue
			}
			offline, err := syncMedia(ctx, eventDir, base, creds, slug, postID, m, st, key)
			if err != nil {
				return res, err
			}
			if offline {
				res.Offline = true
				res.LastError = "network unavailable while publishing media"
				return res, nil
			}
			st.Media[key] = mediaAck{CloudID: m.cloudID, AckedMS: time.Now().UnixMilli()}
			res.MediaPushed++
			if err := saveState(eventDir, st); err != nil {
				return res, err
			}
		}
	}

	return res, nil
}

func readPosts(eventDir string) ([]syncPost, error) {
	data, err := os.ReadFile(filepath.Join(eventDir, "posts.jsonl"))
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var posts []*event.Post
	byID := map[string]*event.Post{}
	for _, raw := range strings.Split(string(data), "\n") {
		if strings.TrimSpace(raw) == "" {
			continue
		}
		var l journalLine
		if json.Unmarshal([]byte(raw), &l) != nil {
			continue
		}
		switch {
		case l.Op == "post" && l.Post != nil:
			p := *l.Post
			p.CID = l.CID
			if p.Act < p.TS {
				p.Act = p.TS
			}
			posts = append(posts, &p)
			byID[p.ID] = &p
		case l.Op == "delete":
			if p, ok := byID[l.ID]; ok {
				p.Deleted = true
			}
		case l.Op == "comment" && l.Comment != nil:
			if p, ok := byID[l.ID]; ok {
				c := *l.Comment
				c.CID = l.CID
				p.Comments = append(p.Comments, c)
				if p.Act < c.TS {
					p.Act = c.TS
				}
			}
		case l.Op == "publish":
			if p, ok := byID[l.ID]; ok {
				p.NoPublish = !l.On
			}
		}
	}

	out := make([]syncPost, 0, len(posts))
	for i, p := range posts {
		localID := p.ID
		if localID == "" {
			localID = fmt.Sprintf("post-%d-%d", i, p.TS)
		}
		cp := cloudPost{
			LocalID:   localID,
			TS:        p.TS,
			Author:    p.Author,
			Emoji:     p.Emoji,
			Text:      p.Text,
			CIDHash:   cidHash(p.CID),
			DJ:        p.DJ,
			NoPublish: p.NoPublish,
			Deleted:   p.Deleted,
			Comments:  []cloudComment{},
		}
		media := make([]mediaItem, 0, len(p.Media))
		for idx, m := range p.Media {
			cm := cloudMedia{LocalID: m.ID, Type: m.Type, Name: m.Name, Size: m.Size}
			cp.Media = append(cp.Media, cm)
			if p.Deleted || p.NoPublish {
				continue
			}
			mi := mediaItem{
				postLocalID: localID,
				localID:     m.ID,
				cloudID:     cloudMediaID(localID, m.ID),
				path:        filepath.Join(eventDir, "media", m.ID),
				typ:         m.Type,
				mime:        mediaMIME(m.ID, m.Type),
				name:        safeHeaderValue(m.Name, 240),
				sort:        idx,
				size:        m.Size,
			}
			media = append(media, mi)
		}
		for j, c := range p.Comments {
			localCommentID := c.ID
			if localCommentID == "" {
				localCommentID = fmt.Sprintf("%s-comment-%d-%d", localID, j, c.TS)
			}
			cp.Comments = append(cp.Comments, cloudComment{
				LocalID: localCommentID,
				TS:      c.TS,
				Author:  c.Author,
				Emoji:   c.Emoji,
				Text:    c.Text,
				DJ:      c.DJ,
			})
		}
		hash, err := stableHash(cp)
		if err != nil {
			return nil, err
		}
		out = append(out, syncPost{post: *p, cloud: cp, hash: hash, media: media})
	}
	return out, nil
}

func postBatches(posts []syncPost) [][]syncPost {
	var batches [][]syncPost
	var cur []syncPost
	comments := 0
	for _, p := range posts {
		nextComments := comments + len(p.cloud.Comments)
		tooMany := len(cur) >= maxPostsPerBatch || nextComments > maxCommentsPerBatch
		if !tooMany && len(cur) > 0 {
			estimate := make([]cloudPost, 0, len(cur)+1)
			for _, existing := range cur {
				estimate = append(estimate, existing.cloud)
			}
			estimate = append(estimate, p.cloud)
			body, _ := json.Marshal(map[string]any{"posts": estimate})
			tooMany = len(body) > maxPostJSONBytes
		}
		if tooMany {
			batches = append(batches, cur)
			cur = nil
			comments = 0
		}
		cur = append(cur, p)
		comments += len(p.cloud.Comments)
	}
	if len(cur) > 0 {
		batches = append(batches, cur)
	}
	return batches
}

func postPosts(ctx context.Context, base string, creds publish.Creds, slug string, posts []cloudPost) error {
	body, err := json.Marshal(map[string]any{
		"id": creds.ID, "secret": creds.Secret, "slug": slug, "posts": posts,
	})
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, base+"/api/broker/publish-posts", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("content-type", "application/json")
	resp, err := httpClient.Do(req)
	if err != nil {
		return transient(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusOK {
		return nil
	}
	return httpStatusErr("publish-posts", resp)
}

func putMedia(ctx context.Context, base string, creds publish.Creds, slug, postID string, m mediaItem) error {
	f, err := os.Open(m.path)
	if err != nil {
		return err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, base+"/api/broker/publish-post-media", f)
	if err != nil {
		return err
	}
	req.ContentLength = st.Size()
	req.Header.Set("content-type", m.mime)
	req.Header.Set("x-pp-id", creds.ID)
	req.Header.Set("x-pp-secret", creds.Secret)
	req.Header.Set("x-pp-slug", slug)
	req.Header.Set("x-pp-post", postID)
	req.Header.Set("x-pp-media", m.cloudID)
	req.Header.Set("x-pp-media-type", m.typ)
	req.Header.Set("x-pp-mime", m.mime)
	req.Header.Set("x-pp-name", m.name)
	req.Header.Set("x-pp-sort", fmt.Sprintf("%d", m.sort))
	resp, err := httpClient.Do(req)
	if err != nil {
		return transient(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusOK {
		return nil
	}
	return httpStatusErr("publish-post-media", resp)
}

func syncMedia(ctx context.Context, eventDir, base string, creds publish.Creds, slug, postID string, m mediaItem, st *stateFile, key string) (bool, error) {
	if m.size < MultipartThreshold {
		return withRetry(ctx, func() error {
			return putMedia(ctx, base, creds, slug, postID, m)
		})
	}
	err := putMediaMultipart(ctx, eventDir, base, creds, slug, postID, m, st, key)
	if err == nil {
		return false, nil
	}
	if isTransient(err) {
		return true, nil
	}
	return false, err
}

type multipartInitResponse struct {
	UploadID string `json:"uploadId"`
	MediaID  string `json:"mediaId"`
	Complete bool   `json:"complete"`
}

type multipartPartAck struct {
	PartNumber int    `json:"partNumber"`
	ETag       string `json:"etag"`
}

func putMediaMultipart(ctx context.Context, eventDir, base string, creds publish.Creds, slug, postID string, m mediaItem, st *stateFile, key string) error {
	info, err := os.Stat(m.path)
	if err != nil {
		return err
	}
	size := info.Size()
	if size < MultipartThreshold {
		return putMedia(ctx, base, creds, slug, postID, m)
	}
	partSize := MultipartPartSize
	if partSize <= 0 {
		partSize = 8 << 20
	}
	progress, ok := st.Uploads[key]
	if !ok || progress.CloudID != m.cloudID || progress.Size != size || progress.PartSize != partSize || progress.UploadID == "" {
		var init multipartInitResponse
		offline, err := withRetry(ctx, func() error {
			var err error
			init, err = initMultipartMedia(ctx, base, creds, slug, postID, m, size)
			return err
		})
		if err != nil {
			return err
		}
		if offline {
			return transient(fmt.Errorf("multipart init offline"))
		}
		if init.Complete {
			delete(st.Uploads, key)
			return nil
		}
		progress = mediaUploadProgress{
			CloudID:   m.cloudID,
			UploadID:  init.UploadID,
			Size:      size,
			PartSize:  partSize,
			Done:      map[string]uploadedPart{},
			UpdatedMS: time.Now().UnixMilli(),
		}
		st.Uploads[key] = progress
		if err := saveState(eventDir, st); err != nil {
			return err
		}
	}
	if progress.Done == nil {
		progress.Done = map[string]uploadedPart{}
	}

	totalParts := int((size + partSize - 1) / partSize)
	var jobs []int
	for part := 1; part <= totalParts; part++ {
		if ack := progress.Done[strconv.Itoa(part)]; ack.ETag != "" {
			continue
		}
		jobs = append(jobs, part)
	}
	if len(jobs) > 0 {
		workers := MultipartConcurrency
		if workers < 1 {
			workers = 1
		}
		if workers > len(jobs) {
			workers = len(jobs)
		}
		jobCh := make(chan int)
		errCh := make(chan error, workers)
		cctx, cancel := context.WithCancel(ctx)
		defer cancel()
		var mu sync.Mutex
		var wg sync.WaitGroup
		for i := 0; i < workers; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				for part := range jobCh {
					offset := int64(part-1) * partSize
					n := partSize
					if remaining := size - offset; remaining < n {
						n = remaining
					}
					ack, err := uploadMultipartMediaPartWithRetry(cctx, base, creds, slug, postID, m, progress.UploadID, part, offset, n)
					if err != nil {
						errCh <- err
						cancel()
						return
					}
					mu.Lock()
					cur := st.Uploads[key]
					if cur.Done == nil {
						cur.Done = map[string]uploadedPart{}
					}
					cur.Done[strconv.Itoa(part)] = uploadedPart{ETag: ack.ETag, Size: n, AckedMS: time.Now().UnixMilli()}
					cur.UpdatedMS = time.Now().UnixMilli()
					st.Uploads[key] = cur
					saveErr := saveState(eventDir, st)
					mu.Unlock()
					if saveErr != nil {
						errCh <- saveErr
						cancel()
						return
					}
				}
			}()
		}
		go func() {
			defer close(jobCh)
			for _, part := range jobs {
				select {
				case jobCh <- part:
				case <-cctx.Done():
					return
				}
			}
		}()
		wg.Wait()
		select {
		case err := <-errCh:
			return err
		default:
		}
	}

	progress = st.Uploads[key]
	parts := make([]multipartPartAck, 0, totalParts)
	for part := 1; part <= totalParts; part++ {
		ack := progress.Done[strconv.Itoa(part)]
		if ack.ETag == "" {
			return transient(fmt.Errorf("multipart part %d not uploaded", part))
		}
		parts = append(parts, multipartPartAck{PartNumber: part, ETag: ack.ETag})
	}
	offline, err := withRetry(ctx, func() error {
		return completeMultipartMedia(ctx, base, creds, slug, postID, m, progress.UploadID, size, parts)
	})
	if err != nil {
		return err
	}
	if offline {
		return transient(fmt.Errorf("multipart complete offline"))
	}
	delete(st.Uploads, key)
	return saveState(eventDir, st)
}

func initMultipartMedia(ctx context.Context, base string, creds publish.Creds, slug, postID string, m mediaItem, size int64) (multipartInitResponse, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, base+"/api/broker/publish-post-media-multipart-init", nil)
	if err != nil {
		return multipartInitResponse{}, err
	}
	setPostMediaHeaders(req, creds, slug, postID, m)
	req.Header.Set("x-pp-size", fmt.Sprintf("%d", size))
	resp, err := httpClient.Do(req)
	if err != nil {
		return multipartInitResponse{}, transient(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return multipartInitResponse{}, httpStatusErr("publish-post-media-multipart-init", resp)
	}
	var out multipartInitResponse
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return multipartInitResponse{}, err
	}
	if out.Complete {
		return out, nil
	}
	if out.UploadID == "" || out.MediaID != m.cloudID {
		return multipartInitResponse{}, fmt.Errorf("bad multipart init response")
	}
	return out, nil
}

func uploadMultipartMediaPartWithRetry(ctx context.Context, base string, creds publish.Creds, slug, postID string, m mediaItem, uploadID string, part int, offset, size int64) (multipartPartAck, error) {
	var ack multipartPartAck
	offline, err := withRetry(ctx, func() error {
		var err error
		ack, err = uploadMultipartMediaPart(ctx, base, creds, slug, postID, m, uploadID, part, offset, size)
		return err
	})
	if err != nil {
		return multipartPartAck{}, err
	}
	if offline {
		return multipartPartAck{}, transient(fmt.Errorf("multipart part %d offline", part))
	}
	return ack, nil
}

func uploadMultipartMediaPart(ctx context.Context, base string, creds publish.Creds, slug, postID string, m mediaItem, uploadID string, part int, offset, size int64) (multipartPartAck, error) {
	f, err := os.Open(m.path)
	if err != nil {
		return multipartPartAck{}, err
	}
	defer f.Close()
	if _, err := f.Seek(offset, io.SeekStart); err != nil {
		return multipartPartAck{}, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, base+"/api/broker/publish-post-media-multipart-part", io.LimitReader(f, size))
	if err != nil {
		return multipartPartAck{}, err
	}
	req.ContentLength = size
	setPostMediaHeaders(req, creds, slug, postID, m)
	req.Header.Set("x-pp-upload-id", uploadID)
	req.Header.Set("x-pp-part-number", strconv.Itoa(part))
	resp, err := httpClient.Do(req)
	if err != nil {
		return multipartPartAck{}, transient(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return multipartPartAck{}, httpStatusErr("publish-post-media-multipart-part", resp)
	}
	var out multipartPartAck
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return multipartPartAck{}, err
	}
	if out.PartNumber != part || out.ETag == "" {
		return multipartPartAck{}, fmt.Errorf("bad multipart part response")
	}
	return out, nil
}

func completeMultipartMedia(ctx context.Context, base string, creds publish.Creds, slug, postID string, m mediaItem, uploadID string, size int64, parts []multipartPartAck) error {
	sort.Slice(parts, func(i, j int) bool { return parts[i].PartNumber < parts[j].PartNumber })
	body, err := json.Marshal(map[string]any{"uploadId": uploadID, "size": size, "parts": parts})
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, base+"/api/broker/publish-post-media-multipart-complete", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("content-type", "application/json")
	setPostMediaHeaders(req, creds, slug, postID, m)
	req.Header.Set("x-pp-upload-id", uploadID)
	req.Header.Set("x-pp-size", fmt.Sprintf("%d", size))
	resp, err := httpClient.Do(req)
	if err != nil {
		return transient(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusOK {
		return nil
	}
	return httpStatusErr("publish-post-media-multipart-complete", resp)
}

func setPostMediaHeaders(req *http.Request, creds publish.Creds, slug, postID string, m mediaItem) {
	req.Header.Set("x-pp-id", creds.ID)
	req.Header.Set("x-pp-secret", creds.Secret)
	req.Header.Set("x-pp-slug", slug)
	req.Header.Set("x-pp-post", postID)
	req.Header.Set("x-pp-media", m.cloudID)
	req.Header.Set("x-pp-media-type", m.typ)
	req.Header.Set("x-pp-mime", m.mime)
	req.Header.Set("x-pp-name", m.name)
	req.Header.Set("x-pp-sort", fmt.Sprintf("%d", m.sort))
}

func httpStatusErr(op string, resp *http.Response) error {
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<10))
	msg := strings.TrimSpace(string(body))
	if msg == "" {
		msg = resp.Status
	}
	err := fmt.Errorf("%s: %s", op, msg)
	if resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode >= 500 {
		return transient(err)
	}
	return err
}

func loadState(eventDir, slug, installID string) (*stateFile, error) {
	st := &stateFile{
		Version:   1,
		Slug:      slug,
		InstallID: installID,
		Posts:     map[string]postAck{},
		Media:     map[string]mediaAck{},
		Uploads:   map[string]mediaUploadProgress{},
	}
	data, err := os.ReadFile(filepath.Join(eventDir, stateName))
	if os.IsNotExist(err) {
		return st, nil
	}
	if err != nil {
		return nil, err
	}
	var loaded stateFile
	if err := json.Unmarshal(data, &loaded); err != nil {
		return nil, err
	}
	if loaded.Slug != slug || loaded.InstallID != installID {
		return st, nil
	}
	if loaded.Posts == nil {
		loaded.Posts = map[string]postAck{}
	}
	if loaded.Media == nil {
		loaded.Media = map[string]mediaAck{}
	}
	if loaded.Uploads == nil {
		loaded.Uploads = map[string]mediaUploadProgress{}
	}
	loaded.Version = 1
	return &loaded, nil
}

func saveState(eventDir string, st *stateFile) error {
	st.UpdatedMS = time.Now().UnixMilli()
	data, err := json.MarshalIndent(st, "", "  ")
	if err != nil {
		return err
	}
	path := filepath.Join(eventDir, stateName)
	tmp, err := os.CreateTemp(eventDir, "."+stateName+".*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		os.Remove(tmpName)
		return err
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmpName)
		return err
	}
	if err := os.Rename(tmpName, path); err != nil {
		os.Remove(tmpName)
		return err
	}
	return nil
}

func stableHash(v any) (string, error) {
	data, err := json.Marshal(v)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:]), nil
}

func cidHash(cid string) string {
	if cid == "" {
		return ""
	}
	sum := sha256.Sum256([]byte(cid))
	return hex.EncodeToString(sum[:])
}

func cloudPostID(slug, installID, localID string) string {
	sum := sha256.Sum256([]byte(slug + ":" + installID + ":" + localID))
	return hex.EncodeToString(sum[:])[:32]
}

func cloudMediaID(postLocalID, mediaLocalID string) string {
	sum := sha256.Sum256([]byte(postLocalID + ":" + mediaLocalID))
	return hex.EncodeToString(sum[:])[:32]
}

func mediaStateKey(postLocalID, mediaLocalID string) string {
	return postLocalID + "/" + mediaLocalID
}

func mediaMIME(name, typ string) string {
	switch strings.ToLower(filepath.Ext(name)) {
	case ".jpg", ".jpeg":
		return "image/jpeg"
	case ".png":
		return "image/png"
	case ".gif":
		return "image/gif"
	case ".webp":
		return "image/webp"
	case ".heic", ".heif":
		return "image/heic"
	case ".mp4", ".m4v":
		return "video/mp4"
	case ".mov":
		return "video/quicktime"
	case ".webm":
		return "video/webm"
	case ".mp3":
		return "audio/mpeg"
	case ".m4a":
		return "audio/mp4"
	case ".aac":
		return "audio/aac"
	case ".wav":
		return "audio/wav"
	}
	if mt := mime.TypeByExtension(filepath.Ext(name)); mt != "" {
		return strings.Split(mt, ";")[0]
	}
	switch typ {
	case "image":
		return "image/jpeg"
	case "video":
		return "video/mp4"
	case "audio":
		return "audio/mpeg"
	default:
		return "application/octet-stream"
	}
}

func safeHeaderValue(s string, max int) string {
	s = filepath.Base(s)
	s = strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return -1
		}
		return r
	}, s)
	if len(s) > max {
		s = s[len(s)-max:]
	}
	return s
}

type transientError struct {
	err error
}

func (e transientError) Error() string {
	return e.err.Error()
}

func (e transientError) Unwrap() error {
	return e.err
}

func transient(err error) error {
	if err == nil {
		return nil
	}
	return transientError{err: err}
}

func withRetry(ctx context.Context, fn func() error) (bool, error) {
	backoffs := []time.Duration{500 * time.Millisecond, 1500 * time.Millisecond, 4 * time.Second}
	var last error
	for attempt := 0; attempt <= len(backoffs); attempt++ {
		if err := ctx.Err(); err != nil {
			return true, nil
		}
		err := fn()
		if err == nil {
			return false, nil
		}
		if !isTransient(err) {
			return false, err
		}
		last = err
		if attempt == len(backoffs) {
			break
		}
		timer := time.NewTimer(backoffs[attempt])
		select {
		case <-timer.C:
		case <-ctx.Done():
			timer.Stop()
			return true, nil
		}
	}
	_ = last
	return true, nil
}

func isTransient(err error) bool {
	var te transientError
	if errors.As(err, &te) {
		return true
	}
	var ue *url.Error
	if errors.As(err, &ue) {
		return true
	}
	var ne net.Error
	if errors.As(err, &ne) {
		return true
	}
	return false
}
