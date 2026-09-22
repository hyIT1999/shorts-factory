-- CreateIndex
CREATE INDEX "Asset_sceneId_idx" ON "Asset"("sceneId");

-- CreateIndex
CREATE INDEX "Job_videoId_type_status_completedAt_idx" ON "Job"("videoId", "type", "status", "completedAt");

-- CreateIndex
CREATE INDEX "Job_projectId_createdAt_idx" ON "Job"("projectId", "createdAt");
