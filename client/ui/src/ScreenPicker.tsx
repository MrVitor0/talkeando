import { useMemo, useState } from "react";
import { Icon } from "./Icon";

export type CaptureSource = {
  id: string;
  kind: "screen" | "window";
  title: string;
  thumbnail: string;
};

export type ShareOptions = { withAudio: boolean; height: number; fps: number; notify: boolean };

// Quick presets for the "QUALIDADE DA TRANSMISSÃO" dropdown. Picking one just
// sets the resolution + frame-rate below; tweaking those flips the label to
// "Personalizado".
const QUALITY_PRESETS = [
  { id: "smooth", label: "Vídeo mais suave", height: 720, fps: 30 },
  { id: "balanced", label: "Equilibrado", height: 1080, fps: 30 },
  { id: "quality", label: "Melhor qualidade", height: 1080, fps: 60 },
  { id: "text", label: "Melhor para leitura de texto", height: 1440, fps: 15 },
] as const;

const RESOLUTIONS = [
  { label: "720", height: 720 },
  { label: "1080", height: 1080 },
  { label: "Fonte", height: 1440 },
] as const;

const FRAME_RATES = [15, 30, 60] as const;

/// The "Qualidade da transmissão" controls (preset dropdown + resolution +
/// frame-rate). Shared between the share wizard's config step and the
/// "Alterar qualidade" popover shown while a share is already live.
export function QualityControls({
  height,
  fps,
  onChange,
}: {
  height: number;
  fps: number;
  onChange: (next: { height: number; fps: number }) => void;
}) {
  const [presetOpen, setPresetOpen] = useState(false);
  const presetLabel = useMemo(() => {
    const match = QUALITY_PRESETS.find(preset => preset.height === height && preset.fps === fps);
    return match ? match.label : "Personalizado";
  }, [height, fps]);
  return (
    <>
      <div className="sp-dropdown">
        <button className="sp-dropdown__toggle" onClick={() => setPresetOpen(open => !open)}>
          <span>{presetLabel}</span>
          <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M7 10l5 5 5-5z" /></svg>
        </button>
        {presetOpen && (
          <div className="sp-dropdown__menu" onMouseLeave={() => setPresetOpen(false)}>
            {QUALITY_PRESETS.map(preset => (
              <button
                key={preset.id}
                className={preset.height === height && preset.fps === fps ? "is-active" : ""}
                onClick={() => { onChange({ height: preset.height, fps: preset.fps }); setPresetOpen(false); }}
              >
                {preset.label}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="sp-seg-grid">
        <div className="sp-seg-col">
          <div className="sp-seg-col__label">Resolução</div>
          <div className="sp-seg">
            {RESOLUTIONS.map(option => (
              <button
                key={option.label}
                className={height === option.height ? "is-active" : ""}
                onClick={() => onChange({ height: option.height, fps })}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
        <div className="sp-seg-col">
          <div className="sp-seg-col__label">Taxa de quadros</div>
          <div className="sp-seg">
            {FRAME_RATES.map(rate => (
              <button
                key={rate}
                className={fps === rate ? "is-active" : ""}
                onClick={() => onChange({ height, fps: rate })}
              >
                {rate}
              </button>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}

function ShareHero() {
  return (
    <div className="sp-hero" aria-hidden="true">
      <svg viewBox="0 0 400 150" preserveAspectRatio="xMidYMid slice">
        <defs>
          <linearGradient id="sp-hero-bg" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#5865f2" />
            <stop offset="1" stopColor="#3b45c4" />
          </linearGradient>
        </defs>
        <rect width="400" height="150" fill="url(#sp-hero-bg)" />
        <circle cx="60" cy="120" r="70" fill="#fff" opacity="0.06" />
        <circle cx="340" cy="30" r="52" fill="#fff" opacity="0.07" />
        <rect x="150" y="42" width="100" height="64" rx="8" fill="#fff" opacity="0.16" />
        <rect x="160" y="52" width="80" height="44" rx="4" fill="#fff" opacity="0.35" />
        <rect x="188" y="106" width="24" height="8" rx="2" fill="#fff" opacity="0.2" />
        <circle cx="110" cy="96" r="12" fill="#fff" opacity="0.28" />
        <circle cx="292" cy="104" r="10" fill="#fff" opacity="0.24" />
        <circle cx="86" cy="44" r="4" fill="#fff" opacity="0.4" />
        <circle cx="316" cy="70" r="3" fill="#fff" opacity="0.4" />
        <circle cx="250" cy="24" r="3" fill="#fff" opacity="0.4" />
      </svg>
    </div>
  );
}

export function ScreenPicker({
  sources,
  loading,
  channelName,
  onPick,
  onCancel,
  // "sourceOnly" = the "change which screen" flow for a share that's already
  // live: pick a source and it applies at once, skipping the quality step.
  sourceOnly = false,
  defaultOptions,
}: {
  sources: CaptureSource[];
  loading: boolean;
  channelName: string;
  onPick: (sourceId: string, options: ShareOptions) => void;
  onCancel: () => void;
  sourceOnly?: boolean;
  defaultOptions?: { withAudio: boolean; height: number; fps: number };
}) {
  const [step, setStep] = useState<"source" | "config">("source");
  const [selected, setSelected] = useState<string | null>(null);
  const [audioOn, setAudioOn] = useState(defaultOptions?.withAudio ?? true);
  const [notify, setNotify] = useState(false);
  const [height, setHeight] = useState<number>(defaultOptions?.height ?? 720);
  const [fps, setFps] = useState<number>(defaultOptions?.fps ?? 30);
  const [sourceTab, setSourceTab] = useState<"window" | "screen">("window");
  const [showAllSources, setShowAllSources] = useState(false);

  const screens = sources.filter(source => source.kind === "screen");
  const windows = sources.filter(source => source.kind === "window");
  const tabSources = sourceTab === "window" ? windows : screens;
  const visibleSources = showAllSources ? tabSources : tabSources.slice(0, 4);
  const selectedSource = sources.find(source => source.id === selected) ?? null;

  function choose(sourceId: string) {
    if (sourceOnly) {
      onPick(sourceId, { withAudio: audioOn, height, fps, notify });
      return;
    }
    setSelected(sourceId);
    setStep("config");
  }

  function goLive() {
    if (!selected) return;
    onPick(selected, { withAudio: audioOn, height, fps, notify });
  }

  const card = (source: CaptureSource) => (
    <button
      key={source.id}
      className={selected === source.id ? "sp-card is-selected" : "sp-card"}
      onClick={() => choose(source.id)}
      title={source.title}
    >
      <div className="sp-card__thumb">
        {source.thumbnail
          ? <img src={source.thumbnail} alt="" />
          : <div className="sp-card__thumb-empty" />}
      </div>
      <span className="sp-card__title">{source.title}</span>
    </button>
  );

  return (
    <div className="sp-overlay" onClick={onCancel}>
      <div className="sp-modal" onClick={event => event.stopPropagation()}>
        {step === "source" ? (
          <div className="sp-source">
            <div className="sp-modal__head sp-source__intro">
              <ShareHero />
              <div className="sp-source__intro-copy">
              <h2>{sourceOnly ? "Trocar de tela" : "Compartilhar sua tela"}</h2>
                <p>{sourceOnly
                  ? "Escolha a tela ou janela e a transmissão troca na hora."
                  : "Escolha o que você quer transmitir para a chamada."}</p>
              </div>
              <button className="sp-x" onClick={onCancel} aria-label="Fechar">✕</button>
            </div>

            <div className="sp-body sp-source__body">
              {loading && <p className="empty">Procurando telas e janelas…</p>}
              {!loading && sources.length === 0 && <p className="empty">Nada encontrado para compartilhar.</p>}

              {sources.length > 0 && (
                <>
                  <div className="sp-tabs" role="tablist" aria-label="Tipo de compartilhamento">
                    <button className={sourceTab === "window" ? "is-active" : ""} role="tab" aria-selected={sourceTab === "window"} onClick={() => { setSourceTab("window"); setShowAllSources(false); }}>
                      Aplicativos <small>{windows.length}</small>
                    </button>
                    <button className={sourceTab === "screen" ? "is-active" : ""} role="tab" aria-selected={sourceTab === "screen"} onClick={() => { setSourceTab("screen"); setShowAllSources(false); }}>
                      Telas <small>{screens.length}</small>
                    </button>
                  </div>
                  {tabSources.length > 0
                    ? <div className="sp-grid sp-grid--source">{visibleSources.map(card)}</div>
                    : <p className="sp-source__empty">Nenhuma opção disponível nesta categoria.</p>}
                  {tabSources.length > 4 && (
                    <button className="sp-show-more" onClick={() => setShowAllSources(value => !value)}>
                      {showAllSources ? "Mostrar menos" : `Ver mais ${tabSources.length - 4} opções`}
                    </button>
                  )}
                </>
              )}
            </div>

            <div className="sp-foot">
              <div className="sp-foot__actions">
                <button className="sp-btn" onClick={onCancel}>Cancelar</button>
                <button className="sp-btn is-primary" disabled={!selected} onClick={() => selected && choose(selected)}>
                  Continuar
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div className="sp-wizard">
            <ShareHero />
            <button className="sp-x sp-x--float" onClick={onCancel} aria-label="Fechar">✕</button>

            <div className="sp-wizard__body">
              <h2 className="sp-wizard__title">Compartilhamento de tela</h2>

              <div className="sp-field">
                <div className="sp-field__label">O que você está transmitindo</div>
                <div className="sp-pick-row">
                  <Icon name={selectedSource?.kind === "window" ? "voice-chat" : "share-screen"} size={18} />
                  <span className="sp-pick-row__name">{selectedSource?.title ?? "Tela"}</span>
                  <button className="sp-change" onClick={() => setStep("source")}>Mudar</button>
                </div>
                <label className="sp-inline-check">
                  <input type="checkbox" checked={audioOn} onChange={event => setAudioOn(event.target.checked)} />
                  Compartilhar áudio
                </label>
                {selectedSource?.kind === "screen" && (
                  <div className="sp-note">
                    <span className="sp-note__mark">!</span>
                    O áudio pode não estar disponível ao compartilhar a tela do seu dispositivo.
                  </div>
                )}
              </div>

              <div className="sp-field">
                <div className="sp-field__label">Canal de transmissão</div>
                <div className="sp-channel-row">
                  <Icon name="voice-chat" size={18} />
                  <span>{channelName}</span>
                </div>
              </div>

              <label className="sp-inline-check sp-inline-check--spaced">
                <input type="checkbox" checked={notify} onChange={event => setNotify(event.target.checked)} />
                Notifique meus amigos neste servidor que estou transmitindo.
              </label>

              <div className="sp-field">
                <div className="sp-field__label">Qualidade da transmissão</div>
                <QualityControls
                  height={height}
                  fps={fps}
                  onChange={next => { setHeight(next.height); setFps(next.fps); }}
                />
              </div>
            </div>

            <div className="sp-wizard__foot">
              <button className="sp-btn" onClick={() => setStep("source")}>Voltar</button>
              <button className="sp-btn is-primary" onClick={goLive}>Ao Vivo</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
