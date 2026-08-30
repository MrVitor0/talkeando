import React, { useState, useEffect, useRef } from "react";
import { Icon } from "./Icon";
import { send } from "./ipc";
import * as rtc from "./rtc";
import type { AudioPipelineStatus, NoiseSuppressionMode } from "./audioPipeline";
import { BANNER_PRESETS, getBannerPreset } from "./banners";

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

export interface ProfileUpdateData {
  display_name?: string;
  bio?: string;
  banner_preset?: string;
  pronouns?: string;
  name_color?: string | null;
}

interface SettingsModalProps {
  onClose: () => void;
  currentUser?: {
    id: string;
    display_name: string;
    username?: string;
    avatar_url?: string | null;
    name_color?: string | null;
    bio?: string | null;
    banner_preset?: string | null;
    pronouns?: string | null;
  } | null;
  onLogout?: () => void;
  onInputModeChange?: (mode: InputMode) => void;
  onShortcutChange?: (code: string) => void;
  onShortcutRecordingChange?: (recording: boolean) => void;
  currentBanner?: string;
  onBannerChange?: (bannerId: string) => void;
  onProfileSave?: (data: ProfileUpdateData) => void;
  initialTab?: "voice" | "account" | "appearance";
}

export function SettingsModal({
  onClose,
  currentUser,
  onLogout,
  onInputModeChange,
  onShortcutChange,
  onShortcutRecordingChange,
  currentBanner = "sakura",
  onBannerChange,
  onProfileSave,
  initialTab = "voice",
}: SettingsModalProps) {
  const [activeTab, setActiveTab] = useState<"voice" | "account" | "appearance">(initialTab);
  const [selectedBanner, setSelectedBanner] = useState<string>(currentUser?.banner_preset || currentBanner);
  const [displayName, setDisplayName] = useState(currentUser?.display_name || "");
  const [pronouns, setPronouns] = useState(currentUser?.pronouns || "");
  const [bio, setBio] = useState(currentUser?.bio || "");
  const [nameColor, setNameColor] = useState(currentUser?.name_color || "");
  const [savedToast, setSavedToast] = useState(false);
  
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
  const [noiseMode, setNoiseMode] = useState<NoiseSuppressionMode>(() => rtc.getNoiseSuppressionMode());
  const [noiseStatus, setNoiseStatus] = useState<AudioPipelineStatus>({ state: "idle", requestedMode: rtc.getNoiseSuppressionMode(), effectiveMode: rtc.getNoiseSuppressionMode(), generation: 0 });

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
  const onShortcutChangeRef = useRef(onShortcutChange);
  onShortcutChangeRef.current = onShortcutChange;
  const onShortcutRecordingChangeRef = useRef(onShortcutRecordingChange);
  onShortcutRecordingChangeRef.current = onShortcutRecordingChange;

  useEffect(() => {
    onShortcutRecordingChangeRef.current?.(recordingKey);
    return () => onShortcutRecordingChangeRef.current?.(false);
  }, [recordingKey]);

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
      onShortcutChangeRef.current?.(code);
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
    onInputModeChange?.(mode);
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

  useEffect(() => rtc.onAudioPipelineStatus(status => {
    setNoiseStatus(status);
    setNoiseMode(status.requestedMode);
  }), []);
  const handleNoiseModeChange = (mode: NoiseSuppressionMode) => {
    setNoiseMode(mode);
    void rtc.setNoiseSuppressionMode(mode).catch(error => console.error("Noise suppression mode switch failed", error));
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
                      step="1"
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
                      step="1"
                      value={outputVol}
                      onChange={e => handleOutputVolChange(parseInt(e.target.value, 10))}
                      className="settings-slider"
                    />
                  </div>
                </div>

                <div className="settings-field" style={{ marginTop: "20px" }}>
                  <label className="settings-label">Redução de ruído</label>
                  <select className="settings-select" value={noiseMode} onChange={event => handleNoiseModeChange(event.target.value as NoiseSuppressionMode)}>
                    <option value="browser">Padrão do dispositivo (AEC + supressão + ganho)</option>
                    <option value="rnnoise">Avançada (RNNoise local)</option>
                    <option value="off">Desativada (mantém cancelamento de eco)</option>
                  </select>
                  <div className="settings-radio-desc" aria-live="polite">
                    {noiseStatus.state === "loading" ? "Carregando processamento avançado…" : noiseStatus.state === "fallback" ? "Processamento avançado indisponível; usando modo padrão." : noiseStatus.state === "failed" ? "Falha ao alterar o processamento de áudio." : noiseStatus.effectiveMode === "rnnoise" ? "RNNoise ativo na track publicada." : noiseStatus.effectiveMode === "off" ? "Sem supressão de ruído nativa ou avançada." : "Usando o processamento nativo do dispositivo."}
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
              <h2 className="settings-tab-title">Perfil & Personalização</h2>

              {/* Profile Card Live Preview */}
              <div
                className="settings-profile-preview"
                style={{
                  background: getBannerPreset(selectedBanner).cssBackground,
                  backgroundSize: "cover",
                  backgroundPosition: "center",
                }}
              >
                <div className="settings-profile-preview__overlay" />
                <div className="settings-profile-preview__body">
                  <Avatar label={displayName || currentUser?.display_name || "User"} imageUrl={currentUser?.avatar_url} size={76} />
                  <div className="settings-profile-preview__meta">
                    <h3 className="settings-profile-preview__name" style={nameColor ? { color: nameColor } : undefined}>
                      {displayName || currentUser?.display_name || "Nome de Exibição"}
                    </h3>
                    <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                      <span className="settings-profile-preview__user">@{currentUser?.username || "membro"}</span>
                      {pronouns && <span className="user-profile-pronouns">{pronouns}</span>}
                    </div>
                    {bio && (
                      <p style={{ margin: "4px 0 0", fontSize: "12px", color: "rgba(255, 255, 255, 0.85)", fontStyle: "italic", maxWidth: "340px" }}>
                        "{bio.length > 75 ? bio.substring(0, 75) + "..." : bio}"
                      </p>
                    )}
                    <span className="settings-profile-preview__badge" style={{ borderColor: getBannerPreset(selectedBanner).accentColor }}>
                      {getBannerPreset(selectedBanner).name}
                    </span>
                  </div>
                </div>
              </div>

              {/* Form Fields for Profile Info */}
              <section className="settings-section" style={{ marginTop: "24px" }}>
                <h3 className="settings-section-heading">Informações do Perfil</h3>

                <div className="settings-field">
                  <label className="settings-label">Nome de Exibição</label>
                  <input
                    type="text"
                    className="settings-input"
                    value={displayName}
                    placeholder="Seu nome no Tupi"
                    maxLength={80}
                    onChange={e => setDisplayName(e.target.value)}
                  />
                </div>

                <div className="settings-field" style={{ marginTop: "14px" }}>
                  <label className="settings-label">Pronomes</label>
                  <input
                    type="text"
                    className="settings-input"
                    value={pronouns}
                    placeholder="ex: ele/dele, ela/dela, they/them"
                    maxLength={40}
                    onChange={e => setPronouns(e.target.value)}
                  />
                </div>

                <div className="settings-field" style={{ marginTop: "14px" }}>
                  <label className="settings-label">Sobre Mim (Biografia)</label>
                  <textarea
                    className="settings-input"
                    style={{ minHeight: "80px", resize: "vertical", fontFamily: "inherit" }}
                    value={bio}
                    placeholder="Conte um pouco sobre você..."
                    maxLength={300}
                    onChange={e => setBio(e.target.value)}
                  />
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "14px", marginTop: "14px" }}>
                  <div className="settings-field">
                    <label className="settings-label">Foto de Perfil</label>
                    <button
                      type="button"
                      className="settings-btn is-secondary"
                      style={{ width: "100%", justifyContent: "center" }}
                      onClick={() => send("profile.avatar.pick")}
                    >
                      <Icon name="camera" size={16} />
                      <span>Alterar Foto</span>
                    </button>
                  </div>

                  <div className="settings-field">
                    <label className="settings-label">Cor do Nome</label>
                    <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                      <input
                        type="color"
                        value={nameColor || "#5865f2"}
                        onChange={e => setNameColor(e.target.value)}
                        style={{ width: "42px", height: "36px", borderRadius: "8px", border: "1px solid rgba(255,255,255,0.15)", background: "transparent", cursor: "pointer" }}
                      />
                      {nameColor && (
                        <button
                          type="button"
                          className="settings-btn is-secondary"
                          style={{ padding: "0 10px", fontSize: "12px" }}
                          onClick={() => setNameColor("")}
                        >
                          Limpar
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              </section>

              {/* Banner Presets Selector */}
              <section className="settings-section" style={{ marginTop: "24px" }}>
                <h3 className="settings-section-heading">Banners de Perfil Predefinidos</h3>
                <p style={{ fontSize: "13px", color: "var(--text-muted)", marginTop: "2px", marginBottom: "14px" }}>
                  Escolha um tema estético para o fundo do seu perfil e da barra de usuário. Ele também é refletido na lista de membros.
                </p>

                <div className="settings-banners-grid">
                  {BANNER_PRESETS.map(banner => {
                    const isSelected = selectedBanner === banner.id;
                    return (
                      <button
                        type="button"
                        key={banner.id}
                        className={`settings-banner-card ${isSelected ? "is-selected" : ""}`}
                        onClick={() => {
                          setSelectedBanner(banner.id);
                          onBannerChange?.(banner.id);
                        }}
                      >
                        <div
                          className="settings-banner-card__thumb"
                          style={{
                            background: banner.cssBackground,
                            backgroundSize: "cover",
                            backgroundPosition: "center",
                          }}
                        >
                          {isSelected && (
                            <div className="settings-banner-card__check">
                              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="3">
                                <polyline points="20 6 9 17 4 12" />
                              </svg>
                            </div>
                          )}
                        </div>
                        <div className="settings-banner-card__info">
                          <span className="settings-banner-card__name">{banner.name}</span>
                          <span className="settings-banner-card__cat">{banner.category}</span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </section>

              {/* Save changes action bar */}
              <div style={{ marginTop: "28px", display: "flex", alignItems: "center", justifyContent: "space-between", background: "rgba(0,0,0,0.3)", padding: "12px 18px", borderRadius: "10px", border: "1px solid rgba(255,255,255,0.1)" }}>
                <div>
                  <span style={{ fontSize: "13px", color: "var(--text-muted)" }}>
                    {savedToast ? "Alterações salvas com sucesso!" : "Salve para atualizar seu perfil em toda a comunidade."}
                  </span>
                </div>
                <button
                  type="button"
                  className="settings-btn is-primary"
                  onClick={() => {
                    onProfileSave?.({
                      display_name: displayName.trim() || undefined,
                      bio: bio.trim() || undefined,
                      banner_preset: selectedBanner,
                      pronouns: pronouns.trim() || undefined,
                      name_color: nameColor || null,
                    });
                    setSavedToast(true);
                    setTimeout(() => setSavedToast(false), 3000);
                  }}
                >
                  {savedToast ? "Salvo!" : "Salvar Alterações"}
                </button>
              </div>
            </div>
          )}

          {activeTab === "appearance" && (
            <div className="settings-tab-pane">
              <h2 className="settings-tab-title">Aparência</h2>
              <p style={{ color: "var(--text-muted)", fontSize: "14px", marginBottom: "16px" }}>
                Tema 3D Dark Glassmorphism ativo por padrão.
              </p>

              <section className="settings-section">
                <h3 className="settings-section-heading">Tema do Banner Ativo</h3>
                <div
                  style={{
                    height: "80px",
                    borderRadius: "12px",
                    background: getBannerPreset(selectedBanner).cssBackground,
                    backgroundSize: "cover",
                    backgroundPosition: "center",
                    display: "flex",
                    alignItems: "center",
                    padding: "0 20px",
                    border: "1px solid rgba(255, 255, 255, 0.12)",
                    boxShadow: "0 4px 16px rgba(0, 0, 0, 0.4)",
                  }}
                >
                  <span style={{ fontWeight: 700, fontSize: "15px", color: "#fff", textShadow: "0 2px 8px rgba(0,0,0,0.8)" }}>
                    {getBannerPreset(selectedBanner).name} ({getBannerPreset(selectedBanner).category})
                  </span>
                </div>
              </section>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
