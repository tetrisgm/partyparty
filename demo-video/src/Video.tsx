import React from 'react';
import {
  AbsoluteFill,
  Img,
  Sequence,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import {loadFont} from '@remotion/google-fonts/Geist';
import hero from '../../site/img/pp-hero.jpg';
import joinRail from '../../site/img/pp-joinrail.png';
import phonePage from '../../site/img/pp-phone.jpg';
import transport from '../../site/img/pp-transport.png';

const {fontFamily} = loadFont('normal', {
  weights: ['400', '700', '800', '900'],
  subsets: ['latin'],
});
const pink = '#ff2d68';
const green = '#31c871';

const fade = (frame: number, start: number, end: number) =>
  interpolate(frame, [start, start + 12, end - 12, end], [0, 1, 1, 0], {
    extrapolateLeft: 'clamp', extrapolateRight: 'clamp',
  });

const MacFrame: React.FC<{children: React.ReactNode; scale?: number}> = ({children, scale = 1}) => (
  <div style={{transform: `scale(${scale})`, transformOrigin: 'center', width: 1320}}>
    <div style={{background: '#111216', borderRadius: 30, padding: '18px 18px 28px', boxShadow: '0 45px 120px #0009, 0 0 0 2px #ffffff22'}}>
      <div style={{height: 36, display: 'flex', alignItems: 'center', gap: 12, paddingLeft: 8}}>
        {['#ff5f57','#febc2e','#28c840'].map((c) => <i key={c} style={{width: 14, height: 14, borderRadius: 20, background: c}} />)}
        <span style={{color: '#8d8e95', fontSize: 16, marginLeft: 425}}>PartyParty</span>
      </div>
      <div style={{borderRadius: 16, overflow: 'hidden', background: '#f7f6f5'}}>{children}</div>
    </div>
    <div style={{height: 20, margin: '0 -80px', borderRadius: '0 0 80px 80px', background: 'linear-gradient(#d7d8dc,#878991)', boxShadow: '0 18px 28px #0008'}} />
  </div>
);

const Console: React.FC<{live: boolean}> = ({live}) => (
  <div style={{height: 680, display: 'grid', gridTemplateColumns: '1fr 360px', color: '#19191d'}}>
    <div style={{padding: 48}}>
      <div style={{height: 220, borderRadius: 24, background: `linear-gradient(0deg,#000a,#0000),url(${hero}) center 46%/cover`, display: 'flex', alignItems: 'flex-end', padding: 34, color: 'white'}}>
        <div><div style={{fontSize: 18, opacity: .75, fontWeight: 700}}>TONIGHT</div><div style={{fontSize: 44, fontWeight: 850}}>Saturday at Mara’s</div></div>
      </div>
      <div style={{marginTop: 36, fontSize: 19, fontWeight: 750, color: '#777'}}>WHAT TO BROADCAST</div>
      <div style={{display: 'flex', gap: 24, marginTop: 14}}>
        <div style={{flex: 1, border: '2px solid #dedde0', borderRadius: 18, padding: '23px 28px', fontSize: 25, fontWeight: 750}}>Mac output (everything) <span style={{float: 'right'}}>⌄</span></div>
        <div style={{width: 310, borderRadius: 18, background: live ? green : pink, color: 'white', display: 'grid', placeItems: 'center', fontSize: 29, fontWeight: 850, boxShadow: `0 14px 30px ${live ? '#31c87155' : '#ff2d6855'}`}}>{live ? '●  Live now' : '🕺  Go live'}</div>
      </div>
      <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 22, marginTop: 32}}>
        {['Room audio','Guest activity'].map((x) => <div key={x} style={{background: 'white', borderRadius: 20, padding: 26, boxShadow: '0 8px 28px #312e3a12'}}><b style={{fontSize: 23}}>{x}</b><p style={{fontSize: 18, color: '#777', marginBottom: 0}}>{live ? 'Connected and ready' : 'Ready when you are'}</p></div>)}
      </div>
    </div>
    <aside style={{background: '#121214', color: 'white', padding: 30}}>
      <div style={{fontSize: 18, color: '#8d8d95', fontWeight: 800}}>INVITE GUESTS</div>
      {live ? <><Img src={joinRail} style={{width: '100%', marginTop: 20, borderRadius: 16}}/><div style={{color: '#7dea9f', marginTop: 20, fontWeight: 750}}>● Secure guest link ready</div></> : <div style={{marginTop: 90, textAlign: 'center', color: '#8d8d95'}}><div style={{fontSize: 54}}>⌁</div><div style={{fontSize: 22, fontWeight: 750, color: 'white', marginTop: 18}}>Your guest link appears here</div><div style={{fontSize: 17, marginTop: 10}}>Start the server to create a secure room.</div></div>}
    </aside>
  </div>
);

const Phone: React.FC<{children: React.ReactNode; scale?: number}> = ({children, scale = 1}) => (
  <div style={{width: 390, height: 844, transform: `scale(${scale})`, transformOrigin: 'center', border: '12px solid #111216', borderRadius: 58, overflow: 'hidden', background: '#f7f7f8', boxShadow: '0 42px 100px #0009, inset 0 0 0 2px #444'}}>
    <div style={{position: 'absolute', zIndex: 9, width: 116, height: 30, borderRadius: 20, background: '#111216', left: 137, top: 10}} />
    {children}
  </div>
);

const MacScene: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const click = spring({frame: frame - 24, fps, config: {damping: 18}});
  const live = frame >= 30;
  return <AbsoluteFill style={{opacity: fade(frame, 0, 75), background: '#0b0b0e', fontFamily, alignItems: 'center', justifyContent: 'center'}}>
    <Img src={hero} style={{position: 'absolute', width: '100%', height: '100%', objectFit: 'cover', filter: 'blur(18px) brightness(.28)', transform: 'scale(1.08)'}}/>
    <div style={{position: 'absolute', top: 70, left: 110, color: 'white'}}><div style={{fontSize: 27, fontWeight: 700, color: '#ff7a9f'}}>STEP 1</div><div style={{fontSize: 58, fontWeight: 900}}>Start the party on your Mac.</div></div>
    <MacFrame scale={.75}><Console live={live}/></MacFrame>
    <div style={{position: 'absolute', left: 1155 + click * 25, top: 655 - click * 6, fontSize: 54, filter: 'drop-shadow(0 5px 5px #0008)', transform: `scale(${1 - click * .18})`}}>➤</div>
  </AbsoluteFill>;
};

const ScanScene: React.FC = () => {
  const frame = useCurrentFrame();
  const scan = interpolate(frame, [0, 50], [185, 610], {extrapolateRight: 'clamp'});
  const pop = spring({frame, fps: 30, config: {damping: 16}});
  return <AbsoluteFill style={{opacity: fade(frame, 0, 70), background: '#101014', fontFamily, color: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 170}}>
    <div><div style={{fontSize: 27, color: '#ff7a9f', fontWeight: 750}}>STEP 2</div><div style={{fontSize: 64, width: 650, lineHeight: 1.02, fontWeight: 900}}>Guests scan.<br/>No app. No account.</div><div style={{fontSize: 25, color: '#b7b7bd', marginTop: 25}}>The secure party page opens instantly.</div></div>
    <Phone scale={.87}><div style={{height: '100%', background: '#060607', position: 'relative'}}><Img src={joinRail} style={{position: 'absolute', width: 330, left: 30, top: 120, borderRadius: 18, transform: `scale(${.86 + pop * .14})`}}/><div style={{position: 'absolute', left: 38, right: 38, top: scan, height: 3, background: pink, boxShadow: `0 0 18px ${pink}`}}/><div style={{position: 'absolute', bottom: 60, left: 0, right: 0, textAlign: 'center', color: '#ccc', fontSize: 17}}>Point camera at the QR code</div></div></Phone>
  </AbsoluteFill>;
};

const ListenScene: React.FC = () => {
  const frame = useCurrentFrame();
  const playing = frame >= 18;
  const pulse = 1 + Math.sin(frame / 3) * .05;
  return <AbsoluteFill style={{opacity: fade(frame, 0, 65), background: 'radial-gradient(circle at 65% 42%,#40202b,#101014 60%)', fontFamily, color: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 160}}>
    <Phone scale={1}><Img src={phonePage} style={{width: '100%', height: '100%', objectFit: 'cover'}}/><div style={{position: 'absolute', left: 16, right: 16, bottom: 20, height: 74, borderRadius: 18, background: playing ? green : '#fff', color: playing ? 'white' : '#16161a', display: 'flex', alignItems: 'center', padding: '0 18px', boxShadow: '0 8px 30px #0005'}}><div style={{fontSize: 28, transform: `scale(${playing ? pulse : 1})`}}>{playing ? '▮▮▮' : '▶'}</div><div style={{marginLeft: 18}}><b style={{fontSize: 18}}>{playing ? 'Playing live' : 'Tap to listen'}</b><div style={{fontSize: 13, opacity: .75}}>Low-latency party audio</div></div></div></Phone>
    <div style={{width: 720}}><div style={{fontSize: 27, color: '#ff7a9f', fontWeight: 750}}>STEP 3</div><div style={{fontSize: 72, lineHeight: .98, fontWeight: 900}}>Tap play.<br/>Keep dancing.</div><div style={{fontSize: 26, color: '#c6c6cc', marginTop: 30, lineHeight: 1.45}}>Native iPhone playback keeps the music going—even when the screen locks.</div>{playing && <div style={{marginTop: 45, display: 'inline-flex', gap: 10, alignItems: 'center', background: '#31c87122', color: '#7dea9f', border: '1px solid #31c87166', padding: '14px 22px', borderRadius: 99, fontSize: 20, fontWeight: 750}}>● PLAYING THE LIVE ROOM</div>}</div>
  </AbsoluteFill>;
};

const EndScene: React.FC = () => {
  const frame = useCurrentFrame();
  const rise = spring({frame, fps: 30, config: {damping: 18}});
  return <AbsoluteFill style={{background: '#f5f3f1', fontFamily, color: '#17171a', overflow: 'hidden'}}>
    <div style={{position: 'absolute', inset: 0, background: 'radial-gradient(circle at 20% 20%,#ff2d681e,transparent 38%),radial-gradient(circle at 80% 70%,#31c87120,transparent 35%)'}}/>
    <div style={{position: 'absolute', left: 120, top: 140, transform: `translateY(${(1-rise)*60}px)`, opacity: rise}}><div style={{fontSize: 34, fontWeight: 850, color: pink}}>PartyParty</div><div style={{fontSize: 82, lineHeight: .98, fontWeight: 930, marginTop: 25}}>Your Mac.<br/>Their phones.<br/><span style={{color: pink}}>One live room.</span></div><div style={{fontSize: 25, color: '#666', marginTop: 35}}>Start the server. Share the code. Play the set.</div></div>
    <div style={{position: 'absolute', right: 100, top: 105, transform: `translateY(${(1-rise)*100}px) rotate(-4deg)`}}><Phone scale={.88}><Img src={phonePage} style={{width: '100%', height: '100%', objectFit: 'cover'}}/><Img src={transport} style={{position: 'absolute', left: 12, right: 12, bottom: 20, width: 366, borderRadius: 18}}/></Phone></div>
  </AbsoluteFill>;
};

export const PartyPartyDemo: React.FC = () => (
  <AbsoluteFill style={{background: '#101014'}}>
    <Sequence from={0} durationInFrames={75}><MacScene/></Sequence>
    <Sequence from={60} durationInFrames={70}><ScanScene/></Sequence>
    <Sequence from={115} durationInFrames={65}><ListenScene/></Sequence>
    <Sequence from={165} durationInFrames={45}><EndScene/></Sequence>
  </AbsoluteFill>
);
