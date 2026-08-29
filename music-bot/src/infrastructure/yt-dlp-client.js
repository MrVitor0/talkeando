class YtDlpClient {
  constructor({ run }) { this.run = run; }

  async searchSoundCloud(query, limit = 5) {
    const { code, out, err } = await this.run([
      "--ignore-config", "--no-progress", "--no-call-home", "--skip-download",
      "--dump-single-json", `scsearch${limit}:${query}`,
    ], { timeoutMs: 45000 });
    if (code !== 0) throw new Error((err || "").trim().split("\n").pop() || `yt-dlp exited ${code}`);
    const body = JSON.parse(out);
    return body.entries || [];
  }
}

module.exports = { YtDlpClient };
