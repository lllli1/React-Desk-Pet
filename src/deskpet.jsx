import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Settings, X, AlignJustify, CloudOff, Cloud } from 'lucide-react';

// --- 核心配置常量 ---
const FRAME_DURATION = 100;
const MOVE_INTERVAL = 10000;
const WS_URL = 'ws://localhost:8011/ws';

// 🔥 分离点击区域和视觉大小
const BASE_HITBOX_SIZE = 150; // 点击/交互区域 (较小)
const BASE_VISUAL_SIZE = 350; // 图片显示区域 (较大)

// 状态帧数定义
const STATE_FRAMES = {
  idle: 12,
  walk: 11,
  drag: 35,
  click: 47,
  feed: 24,
  happy: 10,
  shock: 10,
};

// 状态枚举
const PetState = {
  IDLE: 'idle',
  WALK: 'walk',
  DRAG: 'drag',
  CLICK: 'click',
  FEED: 'feed',
  HAPPY: 'happy',
  SHOCK: 'shock',
};

// 音效管理器
class AudioManager {
  constructor() {
    this.audioCache = {};
    this.currentLoop = null;
    this.volume = 0.5;
  }

  setVolume(vol) {
    this.volume = Math.max(0, Math.min(1, vol));
    if (this.currentLoop) this.currentLoop.volume = this.volume;
  }

  playOneShot(name) {
    // 如果正在播放拖拽音效，不被打断
    if (this.currentLoop && this.currentLoop.src.includes('drag.mp3')) return;
    const audio = new Audio(`/assets/audio/${name}`);
    audio.volume = this.volume;
    audio.play().catch(e => console.warn("Audio play failed:", e));
  }

  startLoop(name) {
    this.stopLoop();
    const audio = new Audio(`/assets/audio/${name}`);
    audio.loop = true;
    audio.volume = this.volume;
    audio.play().catch(e => console.warn("Loop play failed:", e));
    this.currentLoop = audio;
  }

  stopLoop() {
    if (this.currentLoop) {
      this.currentLoop.pause();
      this.currentLoop.currentTime = 0;
      this.currentLoop = null;
    }
  }
}

const audioManager = new AudioManager();

const DeskPet = () => {
  const [imagesLoaded, setImagesLoaded] = useState(false);
  const [pos, setPos] = useState({ x: 100, y: 100 });
  const [petState, setPetState] = useState(PetState.IDLE);
  const [currentFrame, setCurrentFrame] = useState(0);
  const [scale, setScale] = useState(1.0);
  const [volume, setVolume] = useState(0.5);
  const [showSettings, setShowSettings] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [wsConnected, setWsConnected] = useState(false);
  const [debugStatus, setDebugStatus] = useState("Initializing...");
  const [qaHistory, setQaHistory] = useState([]);

  const stateRef = useRef({
    pos: { x: 100, y: 100 },
    target: null,
    petState: PetState.IDLE,
    isDragging: false,
    isMoving: false,
    isPlayingOneShot: false,
    lastFrameTime: 0,
    lastMoveTime: 0,
    ws: null,
    pendingQuestions: {},
    dragOffset: { x: 0, y: 0 },
    // 🔥 修复逻辑新增状态
    hasMoved: false,
    dragStartPos: { x: 0, y: 0 }
  });

  const imageCache = useRef({});

  // 1. 初始化与预加载
  useEffect(() => {
    const preloadImages = async () => {
      console.log("🚀 开始预加载图片...");
      const promises = [];
      Object.entries(STATE_FRAMES).forEach(([stateName, count]) => {
        for (let i = 1; i <= count; i++) {
          const frameNum = i.toString().padStart(3, '0');
          const src = `/assets/images/${stateName}/${stateName}_${frameNum}.png`;
          const p = new Promise((resolve) => {
            const img = new Image();
            img.src = src;
            img.onload = () => resolve(true);
            img.onerror = () => resolve(false);
            imageCache.current[src] = img;
          });
          promises.push(p);
        }
      });

      await Promise.all(promises);
      setImagesLoaded(true);
      
      const startX = window.innerWidth / 2 - (BASE_HITBOX_SIZE * scale) / 2;
      const startY = window.innerHeight / 2 - (BASE_HITBOX_SIZE * scale) / 2;
      setPos({ x: startX, y: startY });
      stateRef.current.pos = { x: startX, y: startY };
    };

    preloadImages();
    connectWebSocket();

    return () => {
      if (stateRef.current.ws) stateRef.current.ws.close();
      audioManager.stopLoop();
    };
  }, []);

  // 2. WebSocket 逻辑
  const connectWebSocket = useCallback(() => {
    if (stateRef.current.ws && stateRef.current.ws.readyState === WebSocket.OPEN) return;
    setDebugStatus("Connecting...");
    const ws = new WebSocket(WS_URL);
    stateRef.current.ws = ws;

    ws.onopen = () => {
      setWsConnected(true);
      setDebugStatus("已连接 ✅");
    };

    ws.onclose = () => {
      setWsConnected(false);
      setDebugStatus("断开重连中...");
      stateRef.current.ws = null;
      setTimeout(connectWebSocket, 5000);
    };

    ws.onerror = (err) => {
      console.error("WS Error:", err);
      ws.close();
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        const { type, request_id: reqId } = data;
        if (type === 'ai_judge_question') {
           if (reqId && data.new_question) stateRef.current.pendingQuestions[reqId] = data.new_question;
        } else if (type === 'ai_judge_result') {
          const question = stateRef.current.pendingQuestions[reqId];
          const score = data.score_result?.score || 0;
          if (question) {
            setQaHistory(prev => [...prev, { question, answer: data.judge_answer || "N/A" }]);
            delete stateRef.current.pendingQuestions[reqId];
          }
          if (score >= 2) triggerAnimation(PetState.HAPPY, 'happy.mp3');
        } else if (type === 'ai_validate_final_result' && data.validation_status === "CORRECT") {
          triggerAnimation(PetState.SHOCK, 'shock.mp3', 2);
        }
      } catch (e) { console.error(e); }
    };
  }, []);

  // 3. 动画与物理循环
  const requestRef = useRef();
  const animate = (time) => {
    const state = stateRef.current;
    
    // 动画帧更新
    if (time - state.lastFrameTime >= FRAME_DURATION) {
      if (imagesLoaded) {
        setCurrentFrame(prev => (prev + 1) % STATE_FRAMES[state.petState]);
      }
      state.lastFrameTime = time;
    }

    // 随机移动
    if (!state.isDragging && !state.isPlayingOneShot && !state.target && time - state.lastMoveTime > MOVE_INTERVAL) {
      startRandomMove();
      state.lastMoveTime = time;
    }

    // 物理移动
    if (state.target && !state.isDragging) {
      const dx = state.target.x - state.pos.x;
      const dy = state.target.y - state.pos.y;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist < 2.0) {
        state.target = null;
        state.isMoving = false;
        changeState(PetState.IDLE);
        state.lastMoveTime = time;
      } else {
        const speed = 2.0; 
        const nextX = state.pos.x + (dx / dist) * speed;
        const nextY = state.pos.y + (dy / dist) * speed;
        
        const currentHitboxSize = BASE_HITBOX_SIZE * scale;
        const boundedX = Math.max(0, Math.min(window.innerWidth - currentHitboxSize, nextX));
        const boundedY = Math.max(0, Math.min(window.innerHeight - currentHitboxSize, nextY));

        state.pos = { x: boundedX, y: boundedY };
        setPos({ x: boundedX, y: boundedY });
      }
    }
    requestRef.current = requestAnimationFrame(animate);
  };

  useEffect(() => {
    requestRef.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(requestRef.current);
  }, [imagesLoaded, scale]);

  const changeState = (newState) => {
    if (stateRef.current.petState !== newState) {
      stateRef.current.petState = newState;
      setPetState(newState);
      setCurrentFrame(0);
      stateRef.current.lastFrameTime = 0;
    }
  };

  const startRandomMove = () => {
    if (stateRef.current.isDragging) return;
    audioManager.playOneShot('walk.mp3');
    changeState(PetState.WALK);
    
    const maxOffset = 300;
    const currentHitboxSize = BASE_HITBOX_SIZE * scale;
    const randX = stateRef.current.pos.x + (Math.random() - 0.5) * 2 * maxOffset;
    const randY = stateRef.current.pos.y + (Math.random() - 0.5) * 2 * maxOffset;

    stateRef.current.target = {
      x: Math.max(0, Math.min(window.innerWidth - currentHitboxSize, randX)),
      y: Math.max(0, Math.min(window.innerHeight - currentHitboxSize, randY))
    };
    stateRef.current.isMoving = true;
  };

  const triggerAnimation = (animState, sound, loops = 1) => {
    if (stateRef.current.isPlayingOneShot) return;
    audioManager.playOneShot(sound);
    stateRef.current.isPlayingOneShot = true;
    stateRef.current.target = null; 
    stateRef.current.isMoving = false;
    setShowSettings(false);
    changeState(animState);

    const duration = FRAME_DURATION * STATE_FRAMES[animState] * loops;
    setTimeout(() => {
      if (!stateRef.current.isDragging && stateRef.current.petState === animState) {
        stateRef.current.isPlayingOneShot = false;
        changeState(PetState.IDLE);
      }
    }, duration);
    stateRef.current.lastMoveTime = performance.now();
  };

  // --- 交互事件 (修复后) ---
  const handleDragStart = (e) => {
    e.preventDefault(); 
    e.stopPropagation();
    
    stateRef.current.isDragging = true;
    stateRef.current.hasMoved = false; // 重置移动标记
    stateRef.current.target = null;
    stateRef.current.isPlayingOneShot = false;
    setShowSettings(false);
    
    const clientX = e.clientX || e.touches?.[0].clientX;
    const clientY = e.clientY || e.touches?.[0].clientY;
    
    // 记录初始位置，不立即切换状态
    stateRef.current.dragStartPos = { x: clientX, y: clientY };

    stateRef.current.dragOffset = {
      x: clientX - stateRef.current.pos.x,
      y: clientY - stateRef.current.pos.y
    };
  };

  const handleDragMove = (e) => {
    if (!stateRef.current.isDragging) return;
    
    const clientX = e.clientX || e.touches?.[0].clientX;
    const clientY = e.clientY || e.touches?.[0].clientY;

    // 🔥 防抖动逻辑：只有移动超过阈值才判定为拖拽
    if (!stateRef.current.hasMoved) {
      const startX = stateRef.current.dragStartPos.x;
      const startY = stateRef.current.dragStartPos.y;
      const dist = Math.sqrt(Math.pow(clientX - startX, 2) + Math.pow(clientY - startY, 2));

      if (dist > 5) { // 5px 阈值
        stateRef.current.hasMoved = true;
        changeState(PetState.DRAG);
        audioManager.startLoop('drag.mp3');
      } else {
        return; // 未超过阈值，视为静止
      }
    }
    
    const newX = clientX - stateRef.current.dragOffset.x;
    const newY = clientY - stateRef.current.dragOffset.y;
    
    const currentHitboxSize = BASE_HITBOX_SIZE * scale;
    const boundedX = Math.max(0, Math.min(window.innerWidth - currentHitboxSize, newX));
    const boundedY = Math.max(0, Math.min(window.innerHeight - currentHitboxSize, newY));

    stateRef.current.pos = { x: boundedX, y: boundedY };
    setPos({ x: boundedX, y: boundedY });
  };

  const handleDragEnd = () => {
    if (!stateRef.current.isDragging) return;
    stateRef.current.isDragging = false;
    audioManager.stopLoop();

    // 🔥 核心逻辑：区分拖拽结束还是点击
    if (stateRef.current.hasMoved) {
      // 拖拽过 -> 恢复待机
      changeState(PetState.IDLE);
    } else {
      // 没怎么动 -> 视为点击 -> 触发互动
      triggerAnimation(PetState.CLICK, 'click.mp3');
    }

    stateRef.current.lastMoveTime = performance.now();
  };

  useEffect(() => {
    // 绑定到 window 确保拖拽不丢失
    window.addEventListener('mouseup', handleDragEnd);
    window.addEventListener('mousemove', handleDragMove);
    window.addEventListener('touchend', handleDragEnd);
    window.addEventListener('touchmove', handleDragMove, { passive: false });
    return () => {
      window.removeEventListener('mouseup', handleDragEnd);
      window.removeEventListener('mousemove', handleDragMove);
      window.removeEventListener('touchend', handleDragEnd);
      window.removeEventListener('touchmove', handleDragMove);
    };
  }, [scale]); 

  // --- 渲染部分 ---

  const renderPet = () => {
    const boxSize = BASE_HITBOX_SIZE * scale;
    const visualW = BASE_VISUAL_SIZE * scale;
    
    if (!imagesLoaded) {
      return (
        <div style={{
          width: boxSize, height: boxSize,
          backgroundColor: 'rgba(255, 64, 129, 0.5)',
          borderRadius: '50%',
          display: 'flex', justifyContent: 'center', alignItems: 'center', color: 'white'
        }}>Loading...</div>
      );
    }

    const frameStr = (currentFrame + 1).toString().padStart(3, '0');
    const src = `/assets/images/${petState}/${petState}_${frameStr}.png`;
    
    let stateScale = 1.0;
    if (petState === PetState.WALK) stateScale = 1.2;
    else if ([PetState.CLICK, PetState.FEED, PetState.HAPPY, PetState.SHOCK].includes(petState)) stateScale = 1.1;

    return (
      <div 
        onMouseDown={handleDragStart}
        onTouchStart={handleDragStart}
        // ❌ 已移除 onClick，防止事件冲突
        style={{
          width: boxSize,
          height: boxSize,
          cursor: stateRef.current.isDragging ? 'grabbing' : 'grab',
          position: 'relative', 
          touchAction: 'none'
        }}
      >
        <div style={{
            position: 'absolute',
            top: '50%', left: '50%',
            width: 0, height: 0,
            overflow: 'visible'
        }}>
            <img 
              src={src} 
              alt="pet" 
              draggable={false}
              style={{ 
                position: 'absolute',
                width: visualW, 
                height: visualW,
                left: -visualW / 2, 
                top: -visualW / 2,
                objectFit: 'contain', 
                transition: 'transform 0.1s',
                transform: `scale(${stateScale})`,
                pointerEvents: 'none', 
                userSelect: 'none',
                WebkitUserDrag: 'none',
              }}
              onError={(e) => { e.target.src = '/assets/images/idle/idle_001.png'; }} 
            />
        </div>
      </div>
    );
  };

  const renderSettings = () => (
    showSettings && (
      <div style={{
        position: 'absolute', 
        left: (BASE_HITBOX_SIZE * scale) / 2 + (BASE_VISUAL_SIZE * scale) / 2 - 20, 
        top: -50,
        width: 160, padding: 12, backgroundColor: 'white',
        borderRadius: 8, boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
        zIndex: 20
      }}>
        <h4 style={{ margin: '0 0 8px 0', fontSize: 14 }}>⚙️ 设置</h4>
        
        <div style={{ fontSize: 12, marginBottom: 4 }}>📏 大小: {scale.toFixed(1)}x</div>
        <input 
          type="range" min="0.5" max="2.0" step="0.1" 
          value={scale} 
          onChange={(e) => {
            const val = parseFloat(e.target.value);
            setScale(val);
            setPos(p => ({
               x: Math.min(p.x, window.innerWidth - BASE_HITBOX_SIZE * val),
               y: Math.min(p.y, window.innerHeight - BASE_HITBOX_SIZE * val)
            }));
          }}
          style={{ width: '100%' }}
        />

        <div style={{ fontSize: 12, marginTop: 8, marginBottom: 4 }}>🔊 音量: {Math.round(volume * 100)}%</div>
        <input 
          type="range" min="0.0" max="1.0" step="0.1" 
          value={volume} 
          onChange={(e) => {
            const val = parseFloat(e.target.value);
            setVolume(val);
            audioManager.setVolume(val);
          }}
          style={{ width: '100%' }}
        />

        <div style={{ borderTop: '1px solid #eee', margin: '10px 0' }} />
        <button 
          onClick={() => triggerAnimation(PetState.FEED, 'feed.mp3', 2)}
          style={{ width: '100%', padding: '6px', backgroundColor: '#e3f2fd', border: 'none', borderRadius: 6, cursor: 'pointer' }}
        >
          <span style={{ marginRight: 6 }}>🍲</span> 喂食
        </button>
        <div style={{ borderTop: '1px solid #eee', margin: '10px 0' }} />
        <div style={{ fontSize: 10, color: '#666', display: 'flex', alignItems: 'center' }}>
          {wsConnected ? <Cloud size={12} color="green" /> : <CloudOff size={12} color="red" />}
          <span style={{ marginLeft: 6 }}>{debugStatus}</span>
        </div>
      </div>
    )
  );

  const renderHistory = () => {
    if (!showHistory) return null;
    const yesItems = qaHistory.filter(i => i.answer === '是');
    const noItems = qaHistory.filter(i => i.answer === '否');
    return (
      <div style={{
        position: 'fixed', top: '10%', left: '10%', right: '10%', bottom: '10%',
        backgroundColor: 'rgba(255,255,255,0.95)',
        borderRadius: 12, boxShadow: '0 4px 20px rgba(0,0,0,0.2)',
        padding: 16, display: 'flex', flexDirection: 'row', zIndex: 10000,
        pointerEvents: 'auto'
      }}>
        <div style={{ flex: 1, overflowY: 'auto', paddingRight: 10, borderRight: '1px solid #ddd' }}>
          <h3 style={{ color: 'green', margin: '0 0 10px 0' }}>Yes</h3>
          {yesItems.map((item, idx) => <div key={idx} style={{ fontSize: 12, marginBottom: 8 }}>Q: {item.question}</div>)}
        </div>
        <div style={{ flex: 1, overflowY: 'auto', paddingLeft: 10 }}>
          <h3 style={{ color: 'red', margin: '0 0 10px 0' }}>No</h3>
          {noItems.map((item, idx) => <div key={idx} style={{ fontSize: 12, marginBottom: 8 }}>Q: {item.question}</div>)}
        </div>
        <button onClick={() => setShowHistory(false)} style={{ position: 'absolute', top: 10, right: 10, border:'none', background:'transparent', cursor:'pointer' }}>
            <X size={24} />
        </button>
      </div>
    );
  };

  const buttonOffset = (BASE_VISUAL_SIZE * scale) / 2 - 20;

  return (
    <div style={{ position: 'fixed', width: '100%', height: '100%', pointerEvents: 'none', zIndex: 9999 }}>
      
      <div style={{
        position: 'absolute',
        left: pos.x,
        top: pos.y,
        width: BASE_HITBOX_SIZE * scale,
        height: BASE_HITBOX_SIZE * scale,
        pointerEvents: 'auto',
      }}>
        
        {renderPet()}

        <div 
          onClick={(e) => { e.stopPropagation(); setShowSettings(!showSettings); if(!showSettings) setShowHistory(false); }}
          style={{
            position: 'absolute', 
            top: '50%', left: '50%',
            transform: `translate(${buttonOffset}px, -${buttonOffset}px)`,
            width: 32, height: 32, borderRadius: '50%',
            backgroundColor: 'rgba(255,255,255,0.8)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            cursor: 'pointer', boxShadow: '0 2px 5px rgba(0,0,0,0.2)', zIndex: 10
          }}
        >
          <Settings size={18} />
        </div>

        <div 
          onClick={(e) => { e.stopPropagation(); setShowHistory(!showHistory); setShowSettings(false); }}
          style={{
            position: 'absolute', 
            top: '50%', left: '50%',
            transform: `translate(-${buttonOffset + 32}px, -${buttonOffset}px)`,
            width: 32, height: 32, borderRadius: '50%',
            backgroundColor: 'rgba(255,255,255,0.8)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            cursor: 'pointer', boxShadow: '0 2px 5px rgba(0,0,0,0.2)', zIndex: 10
          }}
        >
          {showHistory ? <X size={18} /> : <AlignJustify size={18} />}
        </div>

        {renderSettings()}
      </div>

      {renderHistory()}
    </div>
  );
};

export default DeskPet;
