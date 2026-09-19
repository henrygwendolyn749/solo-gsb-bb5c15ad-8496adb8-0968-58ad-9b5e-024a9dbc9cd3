import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Toolbar from './components/Toolbar';
import Timeline from './components/Timeline';
import CueList from './components/CueList';
import type { Constraints, Cue, SilenceStatus } from './types';
import { parseSrt, serializeSrt, formatClock } from './lib/srt';
import {
  commitHistory,
  initHistory,
  redoHistory,
  replaceHistory,
  undoHistory
} from './lib/cues';
import { detectSilences, type WindowLevels } from './lib/silence';
import {
  AbortToken,
  analyzeAudioFile,
  isAbortError
} from './lib/audioAnalysis';
import {
  computeLoopRange,
  loopEnterAction,
  loopTickAction,
  DEFAULT_LOOP_MARGINS,
  LOOP_DISABLED_REASONS,
  type LoopMargins
} from './lib/abLoop';

interface Toast {
  id: number;
  kind: 'warn' | 'info' | 'error';
  text: string;
}

/** dBFS 风格阈值转线性振幅：-60dB≈0.001, -40dB=0.01, -20dB=0.1 */
function dbToAmplitude(db: number): number {
  return Math.min(1, Math.pow(10, db / 20));
}

export default function App() {
  const [history, setHistory] = useState(() => initHistory([]));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [constraints, setConstraints] = useState<Constraints>({
    minDuration: 0.5,
    minGap: 0.08
  });
  const [pps, setPps] = useState(80);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [srtName, setSrtName] = useState<string | null>(null);
  const [audioName, setAudioName] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);

  // 静音分析：吸附开关、可调阈值（dB）、分析状态与窗口能量
  const [snapEnabled, setSnapEnabled] = useState(true);
  const [silenceThresholdDb, setSilenceThresholdDb] = useState(-40);
  const [levels, setLevels] = useState<WindowLevels | null>(null);
  const [silenceStatus, setSilenceStatus] = useState<SilenceStatus>('idle');
  const [silenceError, setSilenceError] = useState<string | null>(null);

  // A-B 循环：开关（切换选择时保留）、前后余量
  const [loopEnabled, setLoopEnabled] = useState(false);
  const [loopMargins, setLoopMargins] = useState<LoopMargins>(DEFAULT_LOOP_MARGINS);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioUrlRef = useRef<string | null>(null);
  const toastId = useRef(0);
  // 当前音频分析的取消令牌；更换音频时取消旧分析并阻止旧结果回写
  const analysisTokenRef = useRef<AbortToken | null>(null);

  const cues = history.present;

  const pushToast = useCallback((kind: Toast['kind'], text: string) => {
    toastId.current += 1;
    const id = toastId.current;
    setToasts((t) => [...t, { id, kind, text }]);
    window.setTimeout(() => {
      setToasts((t) => t.filter((x) => x.id !== id));
    }, 4200);
  }, []);

  /* ---------------- 音频 ---------------- */

  const ensureAudio = useCallback(() => {
    if (!audioRef.current) {
      const el = new Audio();
      el.preload = 'auto';
      el.addEventListener('timeupdate', () => setCurrentTime(el.currentTime));
      el.addEventListener('loadedmetadata', () => setDuration(el.duration || 0));
      el.addEventListener('play', () => setIsPlaying(true));
      el.addEventListener('pause', () => setIsPlaying(false));
      el.addEventListener('ended', () => setIsPlaying(false));
      audioRef.current = el;
    }
    return audioRef.current;
  }, []);

  useEffect(() => {
    return () => {
      analysisTokenRef.current?.abort();
      if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
      audioRef.current?.pause();
    };
  }, []);

  /** 用 Web Audio API 解码并分析窗口能量；token 保证旧音频结果不会回写 */
  const runSilenceAnalysis = useCallback(
    (file: File) => {
      analysisTokenRef.current?.abort();
      const token = new AbortToken();
      analysisTokenRef.current = token;
      setSilenceStatus('analyzing');
      setSilenceError(null);
      analyzeAudioFile(file, token)
        .then((result) => {
          if (token.signal) return; // 已更换音频，丢弃旧结果
          setLevels({ levels: result.levels, windowSize: result.windowSize, duration: result.duration });
          setSilenceStatus('done');
        })
        .catch((err: unknown) => {
          if (isAbortError(err)) return; // 更换音频导致的取消，静默处理
          setSilenceStatus('error');
          setSilenceError(err instanceof Error ? err.message : String(err));
          pushToast('error', `静音分析失败：${err instanceof Error ? err.message : '音频无法解码'}`);
        });
    },
    [pushToast]
  );

  const handleImportAudio = useCallback(
    (file: File) => {
      const el = ensureAudio();
      // 显式暂停并复位状态：换音频后旧播放回调（rAF/timeupdate）不得再拉回播放头
      el.pause();
      setIsPlaying(false);
      if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
      const url = URL.createObjectURL(file);
      audioUrlRef.current = url;
      el.src = url;
      el.load();
      setAudioName(file.name);
      setCurrentTime(0);
      setDuration(0);
      setLevels(null);
      // 音频更换后旧循环区间不再适用，关闭循环（开关不保留）
      setLoopEnabled(false);
      // 取消旧分析（若正在进行），并以新令牌开始本次分析，阻止旧结果回写
      runSilenceAnalysis(file);
      pushToast('info', `已加载音频：${file.name}`);
    },
    [ensureAudio, pushToast, runSilenceAnalysis]
  );

  // 阈值调整时基于窗口能量重新分段（纯前端计算，无需重新解码）
  const silenceThreshold = useMemo(() => dbToAmplitude(silenceThresholdDb), [silenceThresholdDb]);
  const silenceSegments = useMemo(
    () => (levels ? detectSilences(levels, { threshold: silenceThreshold }) : []),
    [levels, silenceThreshold]
  );

  const seek = useCallback(
    (t: number, play = false) => {
      const el = audioRef.current;
      if (!el || !audioUrlRef.current) {
        // 未导入音频时仍允许播放头移动，便于纯字幕检查
        setCurrentTime(Math.max(0, t));
        return;
      }
      const target = Math.max(0, Math.min(t, el.duration || t));
      el.currentTime = target;
      setCurrentTime(target);
      if (play) {
        void el.play().catch(() => pushToast('error', '浏览器拒绝了自动播放，请再点一次播放'));
      }
    },
    [pushToast]
  );

  const seekAndPlay = useCallback((t: number) => seek(t, true), [seek]);

  const togglePlay = useCallback(() => {
    const el = audioRef.current;
    if (!el || !audioUrlRef.current) {
      pushToast('warn', '请先导入浏览器可播放的音频文件');
      return;
    }
    if (el.paused) void el.play();
    else el.pause();
  }, [pushToast]);

  /* ---------------- A-B 循环 ---------------- */

  const selectedCue = useMemo(
    () => cues.find((c) => c.id === selectedId) ?? null,
    [cues, selectedId]
  );

  // 区间计算为纯函数：无音频 / 未选字幕 / 裁剪后为空时给出原因
  const loopResult = useMemo(
    () =>
      computeLoopRange({
        hasAudio: audioName !== null,
        cue: selectedCue,
        margins: loopMargins,
        duration
      }),
    [audioName, selectedCue, loopMargins, duration]
  );

  // 仅当开关打开且区间有效时循环才生效（开关状态在切换选择时保留）
  const activeLoop = loopEnabled && loopResult.ok ? loopResult.range : null;

  // 区间出现 / 更新（开启循环、切换选择、调整余量、拖动选中字幕边界）时：
  // 播放头落在新区间外则立即跳到新 A 点，保持当前播放/暂停状态
  useEffect(() => {
    if (!activeLoop) return;
    const now = audioRef.current?.currentTime ?? 0;
    const action = loopEnterAction(now, activeLoop);
    if (action.type === 'seek') seek(action.to, isPlaying);
    // 只在区间本身变化时评估；currentTime / isPlaying 取当时值即可
  }, [activeLoop]); // eslint-disable-line react-hooks/exhaustive-deps

  // 播放中且循环生效：rAF 逐帧检查，越过 B 点回到 A 点继续。
  // 暂停、关闭循环或更换音频都会清理本效应并取消帧回调，
  // 且 tick 内再次确认元素未暂停，旧回调不会再拉回播放头。
  useEffect(() => {
    if (!activeLoop || !isPlaying) return;
    let raf = 0;
    const tick = () => {
      const el = audioRef.current;
      if (el && !el.paused) {
        const action = loopTickAction(el.currentTime, activeLoop);
        if (action.type === 'seek') {
          el.currentTime = action.to;
          setCurrentTime(action.to);
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [activeLoop, isPlaying]);

  /* ---------------- SRT ---------------- */

  const handleImportSrt = useCallback(
    (file: File) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = parseSrt(String(reader.result ?? ''));
        if (result.cues.length === 0) {
          pushToast('error', '未从该文件解析出任何有效字幕');
          return;
        }
        setHistory((h) => replaceHistory(h, result.cues));
        setSrtName(file.name);
        setSelectedId(result.cues[0]?.id ?? null);
        pushToast('info', `已导入 ${result.cues.length} 条字幕：${file.name}`);
        result.warnings.forEach((w) => pushToast('warn', w));
      };
      reader.onerror = () => pushToast('error', `读取文件失败：${file.name}`);
      reader.readAsText(file, 'utf-8');
    },
    [pushToast]
  );

  /* ---------------- 历史 ---------------- */

  const commit = useCallback((next: Cue[]) => {
    setHistory((h) => commitHistory(h, next));
  }, []);

  const undo = useCallback(() => setHistory((h) => undoHistory(h)), []);
  const redo = useCallback(() => setHistory((h) => redoHistory(h)), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        redo();
      } else if (e.key === ' ') {
        e.preventDefault();
        togglePlay();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo, togglePlay]);

  /* ---------------- 导出 ---------------- */

  const exportSrt = useCallback(() => {
    if (cues.length === 0) {
      pushToast('warn', '没有可导出的字幕');
      return;
    }
    const blob = new Blob([serializeSrt(cues)], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const base = (srtName ?? 'subtitles.srt').replace(/\.srt$/i, '');
    a.href = url;
    a.download = `${base}.fixed.srt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    pushToast('info', '已导出按时间顺序重新编号的 SRT');
  }, [cues, srtName, pushToast]);

  const statusText = useMemo(() => {
    const parts: string[] = [];
    parts.push(cues.length === 0 ? '等待导入：先选择 SRT，再选择音频' : `${cues.length} 条字幕`);
    if (silenceStatus === 'analyzing') parts.push('静音分析中…');
    else if (silenceStatus === 'done') {
      parts.push(`${silenceSegments.length} 段静音` + (snapEnabled ? '· 吸附已开启' : '· 吸附已关闭'));
    } else if (silenceStatus === 'error') parts.push('静音分析失败');
    if (activeLoop) {
      parts.push(`A-B 循环 ${formatClock(activeLoop.a)} → ${formatClock(activeLoop.b)}`);
    } else if (loopEnabled && !loopResult.ok) {
      parts.push(`循环待机：${LOOP_DISABLED_REASONS[loopResult.reason]}`);
    }
    if (cues.length > 0) parts.push(`已记录 ${history.past.length} 次调整`);
    return parts.join(' · ');
  }, [cues.length, history.past.length, silenceStatus, silenceSegments.length, snapEnabled, activeLoop, loopEnabled, loopResult]);

  return (
    <div className="app">
      <Toolbar
        audioName={audioName}
        srtName={srtName}
        isPlaying={isPlaying}
        currentTime={currentTime}
        duration={duration}
        canUndo={history.past.length > 0}
        canRedo={history.future.length > 0}
        pps={pps}
        constraints={constraints}
        onImportSrt={handleImportSrt}
        onImportAudio={handleImportAudio}
        onTogglePlay={togglePlay}
        onSeek={seekAndPlay}
        onUndo={undo}
        onRedo={redo}
        onZoom={setPps}
        onConstraintsChange={setConstraints}
        onExport={exportSrt}
        canExport={cues.length > 0}
        snapEnabled={snapEnabled}
        onSnapEnabledChange={setSnapEnabled}
        silenceThresholdDb={silenceThresholdDb}
        onSilenceThresholdChange={setSilenceThresholdDb}
        silenceStatus={silenceStatus}
        silenceSegmentCount={silenceSegments.length}
        silenceError={silenceError}
        loopEnabled={loopEnabled}
        loopAvailable={loopResult.ok}
        loopDisabledReason={loopResult.ok ? null : LOOP_DISABLED_REASONS[loopResult.reason]}
        loopMargins={loopMargins}
        loopRangeText={
          loopResult.ok
            ? `A ${formatClock(loopResult.range.a)} → B ${formatClock(loopResult.range.b)}`
            : null
        }
        onLoopEnabledChange={setLoopEnabled}
        onLoopMarginsChange={setLoopMargins}
      />

      <main className="main">
        <section className="stage">
          <div className="status-bar">
            <span>{statusText}</span>
            <span className="status-hint">
              拖动字幕块左右边界校对 · 靠近静音带边缘 150ms 自动吸附 · 越界自动回弹并提示原因 · 点击字幕块定位播放 · 开启 A-B 循环反复试听选中字幕
            </span>
          </div>
          <Timeline
            cues={cues}
            duration={duration}
            currentTime={currentTime}
            isPlaying={isPlaying}
            pps={pps}
            constraints={constraints}
            selectedId={selectedId}
            silences={silenceSegments}
            snapEnabled={snapEnabled}
            loopRange={activeLoop}
            onSelect={setSelectedId}
            onSeek={seekAndPlay}
            onCommit={commit}
            onNotice={(text) => pushToast('warn', text)}
          />
        </section>
        <CueList
          cues={cues}
          currentTime={currentTime}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onSeek={seekAndPlay}
        />
      </main>

      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            {t.text}
          </div>
        ))}
      </div>
    </div>
  );
}
