import React, { useState, useEffect, useRef } from "react";
import { Icon } from "./Icon";
import * as rtc from "./rtc";

function Avatar({ label, size, imageUrl }: { label: string; size: number; imageUrl?: string | null }) {
  const initials = (label || "?").substring(0, 2).toUpperCase();
  return (
    <span
      className="avatar"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.4), background: "hsl(220 42% 45%)", display: "inline-flex", alignItems: "center", justifyContent: "center", borderRadius: "50%", overflow: "hidden", color: "#fff", fontWeight: 700 }}
    >
      {imageUrl ? <img src={imageUrl} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : initials}
    </span>
  );
}

export type InputMode = "voice_activity" | "push_to_talk" | "toggle";

interface SettingsModalProps {
  onClose: () => void;
  currentUser?: { id: string; display_name: string; username?: string; avatar_url?: string | null } | null;
  onLogout?: () => void;
}

export function SettingsModal({ onClose, currentUser, onLogout }: SettingsModalProps) {
  const [activeTab, setActiveTab] = useState<"voice" | "account" | "appearance">("voice");
  
  // Devices
  const [audioInputs, setAudioInputs] = useState<MediaDeviceInfo[]>([]);
  const [audioOutputs, setAudioOutputs] = useState<MediaDeviceInfo[]>([]);
  const [videoInputs, setVideoInputs] = useState<MediaDeviceInfo[]>([]);
  
  const [selectedAudioInput, setSelectedAudioInput] = useState<string>(rtc.getAudioInputDeviceId() ?? "");
  const [selectedAudioOutput, setSelectedAudioOutput] = useState<string>(rtc.getAudioOutputDeviceId() ?? "");
  const [selectedVideoInput, setSelectedVideoInput] = useState<string>(() => {
    try { return localStorage.getItem("tk.cameraDeviceId") ?? ""; } catch { return ""; }
  });

  const [inputVol, setInputVol] = useState<number>(() => Math.round(rtc.getInputVolume() * 100));
  const [outputVol, setOutputVol] = useState<number>(() => Math.round(rtc.getOutputVolume() * 100));

  // PTT State
  const [inputMode, setInputMode] = useState<InputMode>(() => {
    try { return (localStorage.getItem("tk.inputMode") as InputMode) || "voice_activity"; } catch { return "voice_activity"; }
  });
  const [pttKey, setPttKey] = useState<string>(() => {
    try { return localStorage.getItem("tk.pttKey") || "KeyV"; } catch { return "KeyV"; }
  });
  const [pttKeyLabel, setPttKeyLabel] = useState<string>(() => {
    try { return localStorage.getItem("tk.pttKeyLabel") || "V"; } catch { return "V"; }
  });
  const [recordingKey, setRecordingKey] = useState(false);

  // Mic Test
  const [testingMic, setTestingMic] = useState(false);
  const [micLevel, setMicLevel] = useState(0);
  const testStreamRef = useRef<MediaStream | null>(null);
  const testAudioCtxRef = useRef<AudioContext | null>(null);
  const testAnimRef = useRef<number | null>(null);

  // Camera Preview
  const [testingVideo, setTestingVideo] = useState(false);
  const [cameraPreviewStream, setCameraPreviewStream] = useState<MediaStream | null>(null);
  const videoPreviewRef = useRef<HTMLVideoElement | null>(null);

  // Load devices on mount
  useEffect(() => {
    let unmounted = false;
    async function loadDevices() {
      const dev = await rtc.listAllMediaDevices();
      if (unmounted) return;
      setAudioInputs(dev.audioInputs);
      setAudioOutputs(dev.audioOutputs);
      setVideoInputs(dev.videoInputs);
    }
    loadDevices();
    return () => { unmounted = true; };
  }, []);

  // Keyboard shortcut ESC to close
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (recordingKey) return;
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose, recordingKey]);

  // Keybind Recorder
  useEffect(() => {
    if (!recordingKey) return;
    const handleRecord = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setRecordingKey(false);
        return;
      }
      const code = e.code;
      let label = e.key.toUpperCase();
      if (code === "Space") label = "Espaço";
      else if (code.startsWith("Key")) label = code.substring(3);
      else if (code.startsWith("Digit")) label = code.substring(5);
      else if (code === "CapsLock") label = "Caps Lock";
      else if (code === "ControlLeft" || code === "ControlRight") label = "Ctrl";
      else if (code === "ShiftLeft" || code === "ShiftRight") label = "Shift";
      else if (code === "AltLeft" || code === "AltRight") label = "Alt";

      setPttKey(code);
      setPttKeyLabel(label);
      try {
        localStorage.setItem("tk.pttKey", code);
        localStorage.setItem("tk.pttKeyLabel", label);
      } catch {}
      setRecordingKey(false);
    };

    window.addEventListener("keydown", handleRecord, { capture: true });
    return () => window.removeEventListener("keydown", handleRecord, { capture: true });
  }, [recordingKey]);

  // Mic Test Logic
  async function toggleMicTest() {
    if (testingMic) {
      stopMicTest();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: selectedAudioInput ? { exact: selectedAudioInput } : undefined,
          echoCancellation: true,
          noiseSuppression: false,
          autoGainControl: false,
        }
      });
      testStreamRef.current = stream;
      const ctx = new AudioContext();
      testAudioCtxRef.current = ctx;
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      const dataArray = new Uint8Array(analyser.frequencyBinCount);

      const updateLevel = () => {
        analyser.getByteFrequencyData(dataArray);
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
        const avg = sum / dataArray.length;
        const normalized = Math.min(100, Math.round((avg / 128) * 100));
        setMicLevel(normalized);
        testAnimRef.current = requestAnimationFrame(updateLevel);
      };
      updateLevel();
      setTestingMic(true);
    } catch (e) {
      console.error("Mic test failed", e);
    }
  }

  function stopMicTest() {
    if (testAnimRef.current) cancelAnimationFrame(testAnimRef.current);
    if (testStreamRef.current) {
      for (const t of testStreamRef.current.getTracks()) t.stop();
      testStreamRef.current = null;
    }
    if (testAudioCtxRef.current) {
      void testAudioCtxRef.current.close();
      testAudioCtxRef.current = null;
    }
    setTestingMic(false);
    setMicLevel(0);
  }

  // Camera preview logic — only active on explicit user request
  async function toggleVideoTest() {
    if (testingVideo) {
      stopVideoTest();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: selectedVideoInput ? { deviceId: { exact: selectedVideoInput } } : true,
      });
      setCameraPreviewStream(stream);
      if (videoPreviewRef.current) videoPreviewRef.current.srcObject = stream;
      setTestingVideo(true);
    } catch (e) {
      console.warn("Camera preview failed", e);
    }
  }

  function stopVideoTest() {
    if (cameraPreviewStream) {
      for (const t of cameraPreviewStream.getTracks()) t.stop();
      setCameraPreviewStream(null);
    }
    if (videoPreviewRef.current) videoPreviewRef.current.srcObject = null;
    setTestingVideo(false);
  }

  // Clean up on unmount
  useEffect(() => {
    return () => {
      stopMicTest();
      if (cameraPreviewStream) {
        for (const t of cameraPreviewStream.getTracks()) t.stop();
      }
    };
  }, [cameraPreviewStream]);

  const handleInputModeChange = (mode: InputMode) => {
    setInputMode(mode);
    try { localStorage.setItem("tk.inputMode", mode); } catch {}
  };

  const handleAudioInputChange = (deviceId: string) => {
    setSelectedAudioInput(deviceId);
    void rtc.setAudioInputDevice(deviceId);
  };

  const handleAudioOutputChange = (deviceId: string) => {
    setSelectedAudioOutput(deviceId);
    void rtc.setAudioOutputDevice(deviceId);
  };

  const handleVideoInputChange = (deviceId: string) => {
    setSelectedVideoInput(deviceId);
    try { localStorage.setItem("tk.cameraDeviceId", deviceId); } catch {}
    void rtc.switchCamera(deviceId);
  };

  const handleInputVolChange = (val: number) => {
    setInputVol(val);
    rtc.setInputVolumeLevel(val / 100);
  };

  const handleOutputVolChange = (val: number) => {
    setOutputVol(val);
    rtc.setOutputVolumeLevel(val / 100);
  };

  return (
    <div className="settings-overlay" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="settings-modal">
        {/* Left Sidebar */}
        <aside className="settings-sidebar">
          {currentUser && (
            <div className="settings-user-header">
              <Avatar label={currentUser.display_name} imageUrl={currentUser.avatar_url} size={48} />
              <div className="settings-user-meta">
                <div className="settings-user-name">{currentUser.display_name}</div>
                <div className="settings-user-sub">@{currentUser.username || "membro"}</div>
              </div>
            </div>
          )}

          <div className="settings-nav-group">
            <div className="settings-nav-title">EXPERIÊNCIA</div>
            <button
              className={`settings-nav-item ${activeTab === "voice" ? "is-active" : ""}`}
              onClick={() => setActiveTab("voice")}
            >
              <Icon name="headphone" size={18} />
              <span>Voz e vídeo</span>
            </button>
            <button
              className={`settings-nav-item ${activeTab === "account" ? "is-active" : ""}`}
              onClick={() => setActiveTab("account")}
            >
              <Icon name="members" size={18} />
              <span>Conta & Perfil</span>
            </button>
            <button
              className={`settings-nav-item ${activeTab === "appearance" ? "is-active" : ""}`}
              onClick={() => setActiveTab("appearance")}
            >
              <Icon name="config" size={18} />
              <span>Aparência</span>
            </button>
          </div>

          <div className="settings-nav-sep" />

          {onLogout && (
            <div className="settings-nav-group">
              <button className="settings-nav-item is-danger" onClick={onLogout}>
                <Icon name="mic-muted" size={18} />
                <span>Sair da conta</span>
              </button>
            </div>
          )}
        </aside>

        {/* Right Content */}
        <main className="settings-content">
          <button className="settings-close-btn" onClick={onClose} title="Fechar (ESC)">
            <span className="settings-close-x">✕</span>
            <span className="settings-close-esc">ESC</span>
          </button>

          {activeTab === "voice" && (
            <div className="settings-tab-pane">
              <h2 className="settings-tab-title">Voz e vídeo</h2>

              {/* Section 1: Audio Devices */}
              <section className="settings-section">
                <h3 className="settings-section-heading">Dispositivos de Áudio</h3>
                
                <div className="settings-grid-2">
                  <div className="settings-field">
                    <label className="settings-label">Microfone (Entrada)</label>
                    <select
                      className="settings-select"
                      value={selectedAudioInput}
                      onChange={e => handleAudioInputChange(e.target.value)}
                    >
                      {audioInputs.length === 0 ? (
                        <option value="">Padrão do Sistema</option>
                      ) : (
                        audioInputs.map(dev => (
                          <option key={dev.deviceId} value={dev.deviceId}>
                            {dev.label || `Microfone (${dev.deviceId.substring(0, 6)})`}
                          </option>
                        ))
                      )}
                    </select>
                  </div>

                  <div className="settings-field">
                    <label className="settings-label">Alto-falante (Saída)</label>
                    <select
                      className="settings-select"
                      value={selectedAudioOutput}
                      onChange={e => handleAudioOutputChange(e.target.value)}
                    >
                      {audioOutputs.length === 0 ? (
                        <option value="">Padrão do Sistema</option>
                      ) : (
                        audioOutputs.map(dev => (
                          <option key={dev.deviceId} value={dev.deviceId}>
                            {dev.label || `Alto-falante (${dev.deviceId.substring(0, 6)})`}
                          </option>
                        ))
                      )}
                    </select>
                  </div>
                </div>

                <div className="settings-grid-2" style={{ marginTop: "16px" }}>
                  <div className="settings-field">
                    <div className="settings-label-row">
                      <label className="settings-label">Volume do Microfone</label>
                      <span className="settings-value">{inputVol}%</span>
                    </div>
                    <input
                      type="range"
                      min="0"
                      max="100"
                      value={inputVol}
                      onChange={e => handleInputVolChange(parseInt(e.target.value, 10))}
                      className="settings-slider"
                    />
                  </div>

                  <div className="settings-field">
                    <div className="settings-label-row">
                      <label className="settings-label">Volume do Alto-falante</label>
                      <span className="settings-value">{outputVol}%</span>
                    </div>
                    <input
                      type="range"
                      min="0"
                      max="100"
                      value={outputVol}
                      onChange={e => handleOutputVolChange(parseInt(e.target.value, 10))}
                      className="settings-slider"
                    />
                  </div>
                </div>

                {/* Mic Test */}
                <div className="settings-field" style={{ marginTop: "20px" }}>
                  <label className="settings-label">Teste do microfone</label>
                  <div className="settings-mic-test-row">
                    <button
                      className={`settings-btn ${testingMic ? "is-testing" : "is-primary"}`}
                      onClick={toggleMicTest}
                    >
                      {testingMic ? "Parar teste" : "Testar microfone"}
                    </button>
                    <div className="settings-meter-track">
                      <div className="settings-meter-fill" style={{ width: `${testingMic ? micLevel : 0}%` }} />
                    </div>
                  </div>
                </div>
              </section>

              {/* Section 2: Input Mode & PTT */}
              <section className="settings-section">
                <h3 className="settings-section-heading">Modo de Entrada</h3>

                <div className="settings-radio-group">
                  <label className="settings-radio-option">
                    <input
                      type="radio"
                      name="inputMode"
                      checked={inputMode === "voice_activity"}
                      onChange={() => handleInputModeChange("voice_activity")}
                    />
                    <div className="settings-radio-content">
                      <span className="settings-radio-title">Atividade de Voz (Padrão)</span>
                      <span className="settings-radio-desc">Microfone sempre aberto e transmitindo quando você fala</span>
                    </div>
                  </label>

                  <label className="settings-radio-option">
                    <input
                      type="radio"
                      name="inputMode"
                      checked={inputMode === "push_to_talk"}
                      onChange={() => handleInputModeChange("push_to_talk")}
                    />
                    <div className="settings-radio-content">
                      <span className="settings-radio-title">Pressionar para Falar (Push-to-Talk)</span>
                      <span className="settings-radio-desc">Você só fala enquanto estiver segurando o atalho definido</span>
                    </div>
                  </label>

                  <label className="settings-radio-option">
                    <input
                      type="radio"
                      name="inputMode"
                      checked={inputMode === "toggle"}
                      onChange={() => handleInputModeChange("toggle")}
                    />
                    <div className="settings-radio-content">
                      <span className="settings-radio-title">Alternar Microfone (Toggle)</span>
                      <span className="settings-radio-desc">Pressione a tecla uma vez para desmutar e outra para mutar</span>
                    </div>
                  </label>
                </div>

                {inputMode !== "voice_activity" && (
                  <div className="settings-field ptt-config-box">
                    <label className="settings-label">Atalho do Teclado</label>
                    <div className="ptt-recorder-row">
                      <div className="ptt-key-badge">{recordingKey ? "Pressione qualquer tecla..." : pttKeyLabel}</div>
                      <button
                        className="settings-btn is-secondary"
                        onClick={() => setRecordingKey(true)}
                        disabled={recordingKey}
                      >
                        {recordingKey ? "Gravando..." : "Gravar Tecla"}
                      </button>
                    </div>
                  </div>
                )}
              </section>

              {/* Section 3: Video / Camera */}
              <section className="settings-section">
                <h3 className="settings-section-heading">Vídeo e Câmera</h3>
                
                <div className="settings-field">
                  <label className="settings-label">Câmera</label>
                  <select
                    className="settings-select"
                    value={selectedVideoInput}
                    onChange={e => handleVideoInputChange(e.target.value)}
                  >
                    {videoInputs.length === 0 ? (
                      <option value="">Nenhuma câmera detectada</option>
                    ) : (
                      videoInputs.map(dev => (
                        <option key={dev.deviceId} value={dev.deviceId}>
                          {dev.label || `Câmera (${dev.deviceId.substring(0, 6)})`}
                        </option>
                      ))
                    )}
                  </select>
                </div>

                <div className="settings-field" style={{ marginTop: "12px" }}>
                  <div className="settings-mic-test-row">
                    <button
                      className={`settings-btn ${testingVideo ? "is-testing" : "is-primary"}`}
                      onClick={toggleVideoTest}
                      disabled={videoInputs.length === 0}
                    >
                      {testingVideo ? "Parar teste de vídeo" : "Testar vídeo"}
                    </button>
                    <span style={{ fontSize: "12px", color: "var(--text-muted)" }}>
                      {testingVideo ? "Câmera ativa para teste" : "A câmera só liga quando você clica em testar ou na chamada"}
                    </span>
                  </div>
                </div>

                <div className="settings-camera-preview-box">
                  {testingVideo && cameraPreviewStream ? (
                    <video ref={videoPreviewRef} autoPlay playsInline muted className="settings-camera-video" />
                  ) : (
                    <div className="settings-camera-empty">
                      <Icon name="camera" size={32} />
                      <span>{testingVideo ? "Iniciando câmera..." : "Clique em \"Testar vídeo\" para pré-visualizar sua câmera"}</span>
                    </div>
                  )}
                </div>
              </section>
            </div>
          )}

          {activeTab === "account" && (
            <div className="settings-tab-pane">
              <h2 className="settings-tab-title">Minha Conta</h2>
              <div className="settings-account-card">
                <Avatar label={currentUser?.display_name ?? "User"} imageUrl={currentUser?.avatar_url} size={80} />
                <div className="settings-account-info">
                  <h3>{currentUser?.display_name}</h3>
                  <p>@{currentUser?.username || "membro"}</p>
                </div>
              </div>
            </div>
          )}

          {activeTab === "appearance" && (
            <div className="settings-tab-pane">
              <h2 className="settings-tab-title">Aparência</h2>
              <p style={{ color: "var(--text-muted)", fontSize: "14px" }}>
                Tema 3D Dark Glassmorphism ativo por padrão.
              </p>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
