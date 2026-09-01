import React from 'react';
import {Composition} from 'remotion';
import {PartyPartyDemo} from './Video';

export const Root: React.FC = () => (
  <Composition
    id="PartyPartyDemo"
    component={PartyPartyDemo}
    durationInFrames={450}
    fps={30}
    width={1920}
    height={1080}
  />
);
