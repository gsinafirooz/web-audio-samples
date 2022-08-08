// Copyright (c) 2022 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

'use strict';

import createLinkFromAudioBuffer from './exporter.mjs';

const context = new AudioContext();

let recordingLength = 0;
let isRecording = false;
let isMonitoring = false;
let visualizationEnabled = true;

// Wait for user interaction to initialize audio, as per specification.
document.addEventListener('click', (element) => {
  init();
  document.querySelector('#click-to-start').remove();
}, {once: true});

/**
 * Defines overall audio chain and initializes all functionality.
 */
async function init() {
  if (context.state === 'suspended') {
    await context.resume();
  }

  // Get user's microphone and connect it to the AudioContext.
  const micStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: false,
      autoGainControl: false,
      noiseSuppression: false,
      latency: 0,
    },
  });

  const micSourceNode = context.createMediaStreamSource(micStream);

  // Visualizers will wait for the processor to
  // initialize before beginning to render.
  const initVisualizers = setupVisualizers(micSourceNode.channelCount);

  const [recordingNode, recordingBuffer, triggerUpdate] =
      await setupRecordingWorkletNode(10);

  // Interpret messages from the processor.
  recordingNode.port.addEventListener('message', (event) => {
    if (event.data.message === 'PROCESSOR_INIT') {
      initVisualizers(recordingBuffer, event.data.liveSampleBuffer);
    }
    if (event.data.message === 'UPDATE_RECORDING_LENGTH') {
      recordingLength = event.data.recordingLength;
    }
  });

  const monitorNode = context.createGain();
  const inputGain = context.createGain();
  const medianEnd = context.createGain();

  setupMonitor(monitorNode);
  handleRecordingButton(
      recordingNode,
      recordingBuffer,
      triggerUpdate,
      micSourceNode.channelCount);

  micSourceNode
      .connect(inputGain)
      .connect(medianEnd)
      .connect(recordingNode)
      .connect(monitorNode)
      .connect(context.destination);
}

/**
 * @typedef {Object} RecordingComponents
 * @property {AudioWorkletNode} recordingNode The recording worklet node.
 * @property {Float32Array} recordingBuffer
 *    Shared buffer containing recorded samples.
 * @property {function} triggerUpdate
 *    Function to call to trigger recording state updates in the processor.
 */

/**
 * Creates ScriptProcessor to record and track microphone audio.
 * @param {number} maxLength Maximum recording length, in seconds.
 * @return {object} Object containing return components.
 * @return {RecordingComponents} Recording node related components for the app.
 */
async function setupRecordingWorkletNode(
    maxLength,
) {
  // A float is 4 bytes, so our length must be 4x
  const recordingBuffer = new Float32Array(
      new SharedArrayBuffer(context.sampleRate * maxLength * 4));

  await context.audioWorklet.addModule('recording-processor.js');

  const WorkletRecordingNode = new AudioWorkletNode(
      context,
      'recording-processor',
      {
        processorOptions: {
          sampleRate: context.sampleRate,
          recordingBuffer: recordingBuffer,
        },
      },
  );

  // Allow other parts of the app to trigger updates in the recording state.
  function triggerUpdate() {
    WorkletRecordingNode.port.postMessage({
      message: 'UPDATE_RECORDING_STATE',
      setRecording: isRecording,
    });
  }

  return {
    recordingNode: WorkletRecordingNode,
    recordingBuffer,
    triggerUpdate,
  };
}

/**
 * Set events and define callbacks for recording start/stop events.
 * @param {AudioWorkletNode} recordingNode
 *    Recording node to watch for a max recording length event from.
 * @param {AudioBuffer} recordingBuffer Buffer of the current recording.
 * @param {function} triggerUpdate Function to inform processor of
 *     recording state update.
 * @param {number} channelCount Microphone channel count,
 *     for accurate recording length calculations.
 */
function handleRecordingButton(
    recordingNode, recordingBuffer, triggerUpdate, channelCount) {
  const recordButton = document.querySelector('#record');
  const recordText = recordButton.querySelector('span');
  const player = document.querySelector('#player');
  const downloadButton = document.querySelector('#download');

  // If the max length is reached, we can no longer record.
  recordingNode.port.addEventListener('message', (event) => {
    if (event.data.message === 'MAX_RECORDING_LENGTH_REACHED') {
      isRecording = false;
      recordText.innerHTML = 'Start';
      recordButton.setAttribute.disabled = true;
    }
  });

  recordButton.addEventListener('click', (e) => {
    isRecording = !isRecording;

    // Inform the AudioProcessor that the recording state changed.
    triggerUpdate();

    // When recording is paused, process clip.
    if (!isRecording) {
      // Display current recording length.
      document.querySelector('#data-len').innerHTML =
          Math.round(recordingLength / context.sampleRate * 100)/100;

      // Create recording file URL for playback and download.
      const wavUrl = createLinkFromAudioBuffer(
          recordingBuffer,
          {
            sampleRate: context.sampleRate,
            numberOfChannels: channelCount,
            recordingLength: recordingLength,
            as32BitFloat: true,
          });

      player.src = wavUrl;
      downloadButton.src = wavUrl;
      downloadButton.download = 'recording.wav';
    }

    recordText.innerHTML = isRecording ? 'Stop' : 'Start';
  });
}

/**
 * Sets up monitor functionality, allowing user to listen to mic audio live.
 * @param {GainNode} monitorNode Gain node to adjust for monitor gain.
 */
function setupMonitor(monitorNode) {
  // Leave audio volume at zero by default.
  monitorNode.gain.value = 0;

  const monitorButton = document.querySelector('#monitor');
  const monitorText = monitorButton.querySelector('span');

  monitorButton.addEventListener('click', (event) => {
    isMonitoring = !isMonitoring;
    const newVal = isMonitoring ? 1 : 0;

    // Set gain to quickly but smoothly slide to new value.
    monitorNode.gain.setTargetAtTime(newVal, context.currentTime, 0.01);

    monitorText.innerHTML = isMonitoring ? 'off' : 'on';
  });
}

/**
 * Sets up and handles calculations and rendering for all visualizers.
 * @return {function} Function to set current input samples for visualization.
 * @param {number} numberOfChannels Number of channels in the recording buffer
 */
function setupVisualizers(numberOfChannels) {
  const drawLiveGain = setupLiveGainVis();
  const drawRecordingGain = setupRecordingGainVis();

  let liveBuffer = [];

  // Wait for processor to initialize before beginning to render.
  const initVisualizer = (liveBufferReference) => {
    liveBuffer = liveBufferReference;
    draw();
  };

  function draw() {
    if (visualizationEnabled) {
      // Calculate current sample's average gain for visualizers to draw with.
      // We only need to calculate this value once per render frame.
      let currentSampleGain = 0;
      const sampleLength = (128);

      for (let i = 0; i < sampleLength; i++) {
        currentSampleGain+=liveBuffer[i];
      }

      currentSampleGain/=sampleLength;
      drawLiveGain(currentSampleGain);

      if (isRecording) {
        drawRecordingGain(currentSampleGain);
      }
    }

    // Request render frame regardless.
    // If visualizers are disabled, function can still wait for enable.
    requestAnimationFrame(draw);
  }

  const visToggle = document.querySelector('#viz-toggle');
  visToggle.addEventListener('click', (e) => {
    visualizationEnabled = !visualizationEnabled;
    visToggle.querySelector('span').innerHTML =
      visualizationEnabled ? 'Pause' : 'Play';
  });

  return initVisualizer;
}

/**
 * Prepares and defines render function for the live gain visualizer.
 * @return {function} Draw function to render incoming live audio.
 */
const setupLiveGainVis = () => {
  const canvas = document.querySelector('#live-canvas');
  const canvasContext = canvas.getContext('2d');

  const width = canvas.width;
  const height = canvas.height;

  const drawStart = width-1;

  function draw(currentSampleGain) {
    // Determine center and height.
    const centerY = ((1 - currentSampleGain) * height) / 2;
    const gainHeight = currentSampleGain * height;

    // Draw gain bar.
    canvasContext.fillStyle = 'black';
    canvasContext.fillRect(drawStart, centerY, 1, gainHeight);

    // Copy visualizer left.
    canvasContext.globalCompositeOperation = 'copy';
    canvasContext.drawImage(canvas, -1, 0);

    // Return to original state, where new visuals.
    // are drawn without clearing the canvas.
    canvasContext.globalCompositeOperation = 'source-over';
  }

  return draw;
};

/**
 * Prepares and defines render function for the recording gain visualizer.
 * @return {function} Draw function to render incoming recorded audio.
 */
function setupRecordingGainVis() {
  const canvas = document.querySelector('#recording-canvas');
  const canvasContext = canvas.getContext('2d');

  const width = canvas.width;
  const height = canvas.height;

  canvasContext.fillStyle = 'red';
  canvasContext.fillRect(0, 0, 1, 1);

  let currentX = 0;

  function draw(currentSampleGain) {
    const centerY = ((1 - currentSampleGain) * height) / 2;
    const gainHeight = currentSampleGain * height;

    // Clear current Y-axis.
    canvasContext.clearRect(currentX, 0, 1, height);

    // Draw recording bar 1 ahead.
    canvasContext.fillStyle = 'red';
    canvasContext.fillRect(currentX+1, 0, 1, height);

    // Draw current gain.
    canvasContext.fillStyle = 'black';
    canvasContext.fillRect(currentX, centerY, 1, gainHeight);

    if (currentX < width - 2) {
      // Keep drawing new waveforms rightwards until canvas is full.
      currentX++;
    } else {
      // If the waveform fills the canvas,
      // move it by one pixel to the left to make room.
      canvasContext.globalCompositeOperation = 'copy';
      canvasContext.drawImage(canvas, -1, 0);

      // Return to original state, where new visuals
      // are drawn without clearing the canvas.
      canvasContext.globalCompositeOperation = 'source-over';
    }
  }

  return draw;
}
