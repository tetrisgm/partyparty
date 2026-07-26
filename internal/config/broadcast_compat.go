package config

// Overrides remains only as the compile-time boundary used by the protected
// broadcaster's dormant override hook. Production has no parser, config source,
// or caller capable of constructing these values. Remove this type with that
// hook after the supervised physical go-live gate permits broadcaster cleanup.
type Overrides struct {
	Bitrate  *string
	Channels *int
	HLSTime  *int
	HLSList  *int
	PartDur  *string
	SegDur   *string
	SegCount *int
}
