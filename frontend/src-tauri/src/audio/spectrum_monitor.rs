use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Runtime};
use tokio::sync::mpsc;

use super::recording_state::DeviceType;

const BAND_COUNT: usize = 6;
const MAX_ANALYSIS_SAMPLES: usize = 4096;
const EMIT_INTERVAL: Duration = Duration::from_millis(80);
const STALE_AFTER: Duration = Duration::from_millis(220);
const ZERO_AFTER: Duration = Duration::from_millis(900);

const BAND_FREQUENCIES: [[f32; 3]; BAND_COUNT] = [
    [90.0, 130.0, 180.0],
    [220.0, 320.0, 460.0],
    [620.0, 850.0, 1150.0],
    [1500.0, 2100.0, 2900.0],
    [3800.0, 5200.0, 7000.0],
    [8500.0, 11500.0, 15000.0],
];

const BAND_GAIN: [f32; BAND_COUNT] = [1.0, 1.05, 1.12, 1.24, 1.45, 1.7];

#[derive(Debug, Serialize, Clone)]
pub struct AudioLevelData {
    pub device_name: String,
    pub device_type: String,
    pub rms_level: f32,
    pub peak_level: f32,
    pub is_active: bool,
    pub frequency_bands: [f32; BAND_COUNT],
}

#[derive(Debug, Serialize, Clone)]
pub struct AudioLevelUpdate {
    pub timestamp: u64,
    pub levels: Vec<AudioLevelData>,
    pub frequency_bands: [f32; BAND_COUNT],
}

#[derive(Clone)]
struct DeviceSpectrumState {
    bands: [f32; BAND_COUNT],
    rms_level: f32,
    peak_level: f32,
    last_update: Option<Instant>,
}

impl Default for DeviceSpectrumState {
    fn default() -> Self {
        Self {
            bands: [0.0; BAND_COUNT],
            rms_level: 0.0,
            peak_level: 0.0,
            last_update: None,
        }
    }
}

struct SpectrumMonitorState {
    sender: Option<mpsc::UnboundedSender<AudioLevelUpdate>>,
    mic: DeviceSpectrumState,
    system: DeviceSpectrumState,
    last_emit: Instant,
}

impl Default for SpectrumMonitorState {
    fn default() -> Self {
        Self {
            sender: None,
            mic: DeviceSpectrumState::default(),
            system: DeviceSpectrumState::default(),
            last_emit: Instant::now() - EMIT_INTERVAL,
        }
    }
}

static SPECTRUM_MONITOR_STATE: LazyLock<Mutex<SpectrumMonitorState>> =
    LazyLock::new(|| Mutex::new(SpectrumMonitorState::default()));

pub fn start<R: Runtime + 'static>(app: AppHandle<R>) {
    let (sender, mut receiver) = mpsc::unbounded_channel::<AudioLevelUpdate>();

    {
        let mut state = SPECTRUM_MONITOR_STATE.lock().unwrap();
        state.sender = Some(sender);
        state.mic = DeviceSpectrumState::default();
        state.system = DeviceSpectrumState::default();
        state.last_emit = Instant::now() - EMIT_INTERVAL;
    }

    tokio::spawn(async move {
        while let Some(update) = receiver.recv().await {
            if let Err(error) = app.emit("audio-levels", &update) {
                log::debug!("Failed to emit audio spectrum levels: {}", error);
            }
        }
    });
}

pub fn stop() {
    let mut state = SPECTRUM_MONITOR_STATE.lock().unwrap();
    state.sender = None;
    state.mic = DeviceSpectrumState::default();
    state.system = DeviceSpectrumState::default();
}

pub fn publish_device_samples(device_type: &DeviceType, samples: &[f32], sample_rate: u32) {
    if samples.is_empty() || sample_rate == 0 {
        return;
    }

    let sender = {
        let state = SPECTRUM_MONITOR_STATE.lock().unwrap();
        state.sender.clone()
    };

    if sender.is_none() {
        return;
    }

    let analysis = analyze_samples(samples, sample_rate);
    let now = Instant::now();

    let (sender, update) = {
        let mut state = SPECTRUM_MONITOR_STATE.lock().unwrap();
        let sender = match state.sender.clone() {
            Some(sender) => sender,
            None => return,
        };

        let target = match device_type {
            DeviceType::Microphone => &mut state.mic,
            DeviceType::System => &mut state.system,
        };

        target.bands = smooth_bands(target.bands, analysis.frequency_bands);
        target.rms_level = smooth_level(target.rms_level, analysis.rms_level);
        target.peak_level = smooth_level(target.peak_level, analysis.peak_level);
        target.last_update = Some(now);

        apply_stale_decay(&mut state.mic, now);
        apply_stale_decay(&mut state.system, now);

        if now.duration_since(state.last_emit) < EMIT_INTERVAL {
            return;
        }

        state.last_emit = now;

        let combined_bands = combine_bands(&state.mic.bands, &state.system.bands);
        let update = AudioLevelUpdate {
            timestamp: current_timestamp_ms(),
            levels: vec![
                build_level_data("Microphone", "input", &state.mic, now),
                build_level_data("System Audio", "output", &state.system, now),
            ],
            frequency_bands: combined_bands,
        };

        (sender, update)
    };

    let _ = sender.send(update);
}

struct SampleAnalysis {
    frequency_bands: [f32; BAND_COUNT],
    rms_level: f32,
    peak_level: f32,
}

fn analyze_samples(samples: &[f32], sample_rate: u32) -> SampleAnalysis {
    let sample_count = samples.len().min(MAX_ANALYSIS_SAMPLES);
    let start = samples.len().saturating_sub(sample_count);
    let window = &samples[start..];

    let rms_level = calculate_rms(window);
    let peak_level = window.iter().map(|sample| sample.abs()).fold(0.0_f32, f32::max);

    if rms_level < 0.00035 && peak_level < 0.0015 {
        return SampleAnalysis {
            frequency_bands: [0.0; BAND_COUNT],
            rms_level,
            peak_level,
        };
    }

    let sample_rate = sample_rate as f32;
    let nyquist = sample_rate * 0.5;
    let mut bands = [0.0; BAND_COUNT];

    for (band_index, frequencies) in BAND_FREQUENCIES.iter().enumerate() {
        let mut total = 0.0;
        let mut count = 0.0;

        for frequency in frequencies {
            if *frequency < nyquist * 0.92 {
                total += goertzel_magnitude(window, sample_rate, *frequency);
                count += 1.0;
            }
        }

        if count > 0.0 {
            let average_magnitude = total / count;
            bands[band_index] = normalize_band(average_magnitude, rms_level, band_index);
        }
    }

    SampleAnalysis {
        frequency_bands: bands,
        rms_level: rms_level.min(1.0),
        peak_level: peak_level.min(1.0),
    }
}

fn goertzel_magnitude(samples: &[f32], sample_rate: f32, target_frequency: f32) -> f32 {
    if samples.len() < 16 {
        return 0.0;
    }

    let omega = 2.0 * std::f32::consts::PI * target_frequency / sample_rate;
    let coeff = 2.0 * omega.cos();
    let mut previous = 0.0;
    let mut previous_2 = 0.0;
    let last_index = (samples.len() - 1) as f32;

    for (index, sample) in samples.iter().enumerate() {
        let hann = 0.5 - 0.5 * ((2.0 * std::f32::consts::PI * index as f32) / last_index).cos();
        let value = sample * hann;
        let current = value + coeff * previous - previous_2;
        previous_2 = previous;
        previous = current;
    }

    let power = previous_2 * previous_2 + previous * previous - coeff * previous * previous_2;
    (power.max(0.0).sqrt() * 2.0) / samples.len() as f32
}

fn calculate_rms(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }

    (samples.iter().map(|sample| sample * sample).sum::<f32>() / samples.len() as f32).sqrt()
}

fn normalize_band(magnitude: f32, rms_level: f32, band_index: usize) -> f32 {
    let noise_gate = if rms_level < 0.001 { 0.0 } else { 1.0 };
    let scaled = magnitude * 38.0 * BAND_GAIN[band_index] * noise_gate;
    scaled.clamp(0.0, 1.0).powf(0.55)
}

fn smooth_bands(previous: [f32; BAND_COUNT], next: [f32; BAND_COUNT]) -> [f32; BAND_COUNT] {
    let mut smoothed = [0.0; BAND_COUNT];

    for index in 0..BAND_COUNT {
        let attack = if next[index] > previous[index] { 0.68 } else { 0.26 };
        smoothed[index] = previous[index] * (1.0 - attack) + next[index] * attack;
    }

    smoothed
}

fn smooth_level(previous: f32, next: f32) -> f32 {
    let attack = if next > previous { 0.65 } else { 0.28 };
    previous * (1.0 - attack) + next * attack
}

fn apply_stale_decay(device: &mut DeviceSpectrumState, now: Instant) {
    let Some(last_update) = device.last_update else {
        return;
    };

    let age = now.duration_since(last_update);
    if age > ZERO_AFTER {
        device.bands = [0.0; BAND_COUNT];
        device.rms_level = 0.0;
        device.peak_level = 0.0;
    } else if age > STALE_AFTER {
        for band in &mut device.bands {
            *band *= 0.78;
        }
        device.rms_level *= 0.78;
        device.peak_level *= 0.78;
    }
}

fn combine_bands(mic_bands: &[f32; BAND_COUNT], system_bands: &[f32; BAND_COUNT]) -> [f32; BAND_COUNT] {
    let mut combined = [0.0; BAND_COUNT];

    for index in 0..BAND_COUNT {
        combined[index] = ((mic_bands[index] * mic_bands[index])
            + (system_bands[index] * system_bands[index]))
            .sqrt()
            .min(1.0);
    }

    combined
}

fn build_level_data(
    device_name: &str,
    device_type: &str,
    state: &DeviceSpectrumState,
    now: Instant,
) -> AudioLevelData {
    let is_active = state
        .last_update
        .map(|last_update| now.duration_since(last_update) <= STALE_AFTER && state.rms_level > 0.001)
        .unwrap_or(false);

    AudioLevelData {
        device_name: device_name.to_string(),
        device_type: device_type.to_string(),
        rms_level: state.rms_level.min(1.0),
        peak_level: state.peak_level.min(1.0),
        is_active,
        frequency_bands: state.bands,
    }
}

fn current_timestamp_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
