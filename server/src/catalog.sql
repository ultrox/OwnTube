CREATE TABLE IF NOT EXISTS catalog_sources(
    id TEXT PRIMARY KEY, payload TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS catalog_videos(
    source TEXT NOT NULL REFERENCES catalog_sources(id),
    video TEXT NOT NULL, score REAL NOT NULL, search TEXT NOT NULL, payload TEXT NOT NULL,
    PRIMARY KEY(source, video)
);
CREATE TABLE IF NOT EXISTS catalog_categories(
    source TEXT NOT NULL, category TEXT NOT NULL, video TEXT NOT NULL,
    PRIMARY KEY(source, category, video),
    FOREIGN KEY(source, video) REFERENCES catalog_videos(source, video) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS catalog_rank ON catalog_videos(source, score DESC, video);
