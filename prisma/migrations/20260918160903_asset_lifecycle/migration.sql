-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Asset" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sceneId" TEXT,
    "type" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "externalId" TEXT,
    "url" TEXT,
    "localPath" TEXT,
    "width" INTEGER,
    "height" INTEGER,
    "duration" REAL,
    "metadataJson" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DISCOVERED',
    "mimeType" TEXT,
    "sizeBytes" INTEGER,
    "videoId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Asset_sceneId_fkey" FOREIGN KEY ("sceneId") REFERENCES "Scene" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Asset_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "Video" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Asset" ("createdAt", "duration", "externalId", "height", "id", "localPath", "metadataJson", "provider", "sceneId", "type", "url", "width") SELECT "createdAt", "duration", "externalId", "height", "id", "localPath", "metadataJson", "provider", "sceneId", "type", "url", "width" FROM "Asset";
DROP TABLE "Asset";
ALTER TABLE "new_Asset" RENAME TO "Asset";
CREATE INDEX "Asset_videoId_idx" ON "Asset"("videoId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
