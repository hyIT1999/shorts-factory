-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Scene" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "videoId" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "duration" REAL,
    "visualPrompt" TEXT,
    "visualType" TEXT,
    "startTime" REAL,
    "endTime" REAL,
    "subtitleEmphasisJson" TEXT,
    "assetId" TEXT,
    "voiceAssetId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Scene_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "Video" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Scene_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Scene_voiceAssetId_fkey" FOREIGN KEY ("voiceAssetId") REFERENCES "Asset" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Scene" ("assetId", "createdAt", "duration", "endTime", "id", "index", "startTime", "subtitleEmphasisJson", "text", "updatedAt", "videoId", "visualPrompt", "visualType") SELECT "assetId", "createdAt", "duration", "endTime", "id", "index", "startTime", "subtitleEmphasisJson", "text", "updatedAt", "videoId", "visualPrompt", "visualType" FROM "Scene";
DROP TABLE "Scene";
ALTER TABLE "new_Scene" RENAME TO "Scene";
CREATE UNIQUE INDEX "Scene_assetId_key" ON "Scene"("assetId");
CREATE UNIQUE INDEX "Scene_voiceAssetId_key" ON "Scene"("voiceAssetId");
CREATE UNIQUE INDEX "Scene_videoId_index_key" ON "Scene"("videoId", "index");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
