use serde::Serialize;
use wasm_bindgen::prelude::*;

const G: f64 = 0.42;
const FIXED_TIME_STEP: f64 = 1.0 / 240.0;
const MAX_FRAME_TIME: f64 = 0.35;
const SOFTENING: f64 = 0.018;
const MAX_STEPS_PER_FRAME: usize = 96;
const TIME_SCALE: f64 = 0.14;

#[derive(Clone)]
struct BodyState {
    mass: f64,
    position: [f64; 3],
    velocity: [f64; 3],
}

#[derive(Clone)]
struct BodyTemplate {
    name: &'static str,
    mass: f64,
    radius: f32,
    orbit_radius: f64,
    orbit_speed_multiplier: f64,
    phase: f64,
    inclination: f64,
    color: &'static str,
    trail_color: &'static str,
    glow_color: &'static str,
    parent_index: Option<usize>,
    is_sun: bool,
}

#[derive(Clone, Serialize)]
struct BodyMetadata {
    name: String,
    radius: f32,
    color: String,
    trail_color: String,
    glow_color: String,
    parent_index: Option<usize>,
    is_sun: bool,
}

#[wasm_bindgen]
pub struct GravitySimulation {
    templates: Vec<BodyTemplate>,
    initial_bodies: Vec<BodyState>,
    bodies: Vec<BodyState>,
    paused: bool,
    accumulator: f64,
}

#[wasm_bindgen]
impl GravitySimulation {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        let templates = default_templates();
        let initial_bodies = build_initial_states(&templates);

        Self {
            templates,
            initial_bodies: initial_bodies.clone(),
            bodies: initial_bodies,
            paused: false,
            accumulator: 0.0,
        }
    }

    pub fn update(&mut self, real_delta_seconds: f64, simulation_speed: f64) {
        if self.paused {
            return;
        }

        let delta = real_delta_seconds.clamp(0.0, MAX_FRAME_TIME);
        self.accumulator += delta * simulation_speed.max(0.0) * TIME_SCALE;

        let mut steps = 0;
        while self.accumulator >= FIXED_TIME_STEP && steps < MAX_STEPS_PER_FRAME {
            self.integrate(FIXED_TIME_STEP);
            self.accumulator -= FIXED_TIME_STEP;
            steps += 1;
        }
    }

    pub fn set_paused(&mut self, paused: bool) {
        self.paused = paused;
    }

    pub fn is_paused(&self) -> bool {
        self.paused
    }

    pub fn reset(&mut self) {
        self.bodies = self.initial_bodies.clone();
        self.accumulator = 0.0;
        self.paused = false;
    }

    pub fn body_count(&self) -> usize {
        self.bodies.len()
    }

    pub fn get_positions(&self) -> Vec<f32> {
        let mut positions = Vec::with_capacity(self.bodies.len() * 3);

        for body in &self.bodies {
            positions.push(body.position[0] as f32);
            positions.push(body.position[1] as f32);
            positions.push(body.position[2] as f32);
        }

        positions
    }

    pub fn get_body_metadata(&self) -> Result<JsValue, JsValue> {
        let metadata: Vec<BodyMetadata> = self
            .templates
            .iter()
            .map(|template| BodyMetadata {
                name: template.name.to_string(),
                radius: template.radius,
                color: template.color.to_string(),
                trail_color: template.trail_color.to_string(),
                glow_color: template.glow_color.to_string(),
                parent_index: template.parent_index,
                is_sun: template.is_sun,
            })
            .collect();

        serde_wasm_bindgen::to_value(&metadata)
            .map_err(|error| JsValue::from_str(&error.to_string()))
    }
}

impl GravitySimulation {
    fn integrate(&mut self, step: f64) {
        let accelerations = self.compute_accelerations();

        for (body, acceleration) in self.bodies.iter_mut().zip(accelerations.iter()) {
            body.velocity[0] += acceleration[0] * step;
            body.velocity[1] += acceleration[1] * step;
            body.velocity[2] += acceleration[2] * step;

            body.position[0] += body.velocity[0] * step;
            body.position[1] += body.velocity[1] * step;
            body.position[2] += body.velocity[2] * step;
        }
    }

    fn compute_accelerations(&self) -> Vec<[f64; 3]> {
        let mut accelerations = vec![[0.0, 0.0, 0.0]; self.bodies.len()];

        for i in 0..self.bodies.len() {
            for j in 0..self.bodies.len() {
                if i == j {
                    continue;
                }

                let direction = [
                    self.bodies[j].position[0] - self.bodies[i].position[0],
                    self.bodies[j].position[1] - self.bodies[i].position[1],
                    self.bodies[j].position[2] - self.bodies[i].position[2],
                ];

                let distance_squared = direction[0] * direction[0]
                    + direction[1] * direction[1]
                    + direction[2] * direction[2]
                    + SOFTENING;
                let distance = distance_squared.sqrt();
                let inverse_distance_cubed = 1.0 / (distance_squared * distance);
                let scale = G * self.bodies[j].mass * inverse_distance_cubed;

                accelerations[i][0] += direction[0] * scale;
                accelerations[i][1] += direction[1] * scale;
                accelerations[i][2] += direction[2] * scale;
            }
        }

        accelerations
    }
}

fn default_templates() -> Vec<BodyTemplate> {
    vec![
        BodyTemplate {
            name: "Sun",
            mass: 2200.0,
            radius: 3.9,
            orbit_radius: 0.0,
            orbit_speed_multiplier: 0.0,
            phase: 0.0,
            inclination: 0.0,
            color: "#f9b84d",
            trail_color: "#f9c977",
            glow_color: "#ffcc66",
            parent_index: None,
            is_sun: true,
        },
        BodyTemplate {
            name: "Mercury",
            mass: 0.03,
            radius: 0.48,
            orbit_radius: 7.0,
            orbit_speed_multiplier: 1.04,
            phase: 0.5,
            inclination: 0.12,
            color: "#c7b39d",
            trail_color: "#d9bf9b",
            glow_color: "#f4cfac",
            parent_index: Some(0),
            is_sun: false,
        },
        BodyTemplate {
            name: "Venus",
            mass: 0.07,
            radius: 0.78,
            orbit_radius: 10.0,
            orbit_speed_multiplier: 0.97,
            phase: 1.4,
            inclination: 0.06,
            color: "#d9b88a",
            trail_color: "#edc99b",
            glow_color: "#f2d2aa",
            parent_index: Some(0),
            is_sun: false,
        },
        BodyTemplate {
            name: "Earth",
            mass: 0.09,
            radius: 0.84,
            orbit_radius: 14.0,
            orbit_speed_multiplier: 1.0,
            phase: 2.2,
            inclination: 0.02,
            color: "#55a6ff",
            trail_color: "#79c4ff",
            glow_color: "#8fe5ff",
            parent_index: Some(0),
            is_sun: false,
        },
        BodyTemplate {
            name: "Moon",
            mass: 0.0012,
            radius: 0.24,
            orbit_radius: 1.9,
            orbit_speed_multiplier: 1.26,
            phase: 0.9,
            inclination: 0.2,
            color: "#d9dde5",
            trail_color: "#dce7f1",
            glow_color: "#ffffff",
            parent_index: Some(3),
            is_sun: false,
        },
        BodyTemplate {
            name: "Mars",
            mass: 0.04,
            radius: 0.64,
            orbit_radius: 18.0,
            orbit_speed_multiplier: 0.95,
            phase: 2.9,
            inclination: 0.08,
            color: "#cb6546",
            trail_color: "#f09173",
            glow_color: "#ffb38f",
            parent_index: Some(0),
            is_sun: false,
        },
        BodyTemplate {
            name: "Jupiter",
            mass: 2.3,
            radius: 1.9,
            orbit_radius: 26.0,
            orbit_speed_multiplier: 0.9,
            phase: 3.6,
            inclination: 0.05,
            color: "#d8b390",
            trail_color: "#efcaa6",
            glow_color: "#ffe0b9",
            parent_index: Some(0),
            is_sun: false,
        },
        BodyTemplate {
            name: "Saturn",
            mass: 1.2,
            radius: 1.6,
            orbit_radius: 34.0,
            orbit_speed_multiplier: 0.88,
            phase: 4.4,
            inclination: 0.09,
            color: "#d7cb95",
            trail_color: "#e8dca7",
            glow_color: "#fff0bf",
            parent_index: Some(0),
            is_sun: false,
        },
        BodyTemplate {
            name: "Uranus",
            mass: 0.42,
            radius: 1.18,
            orbit_radius: 43.0,
            orbit_speed_multiplier: 0.84,
            phase: 5.1,
            inclination: 0.1,
            color: "#89d7dc",
            trail_color: "#a4f0f3",
            glow_color: "#bafcff",
            parent_index: Some(0),
            is_sun: false,
        },
        BodyTemplate {
            name: "Neptune",
            mass: 0.5,
            radius: 1.14,
            orbit_radius: 51.0,
            orbit_speed_multiplier: 0.82,
            phase: 5.8,
            inclination: 0.07,
            color: "#4b78d8",
            trail_color: "#7aa5ff",
            glow_color: "#b1c6ff",
            parent_index: Some(0),
            is_sun: false,
        },
    ]
}

fn build_initial_states(templates: &[BodyTemplate]) -> Vec<BodyState> {
    let mut states: Vec<BodyState> = Vec::with_capacity(templates.len());

    for template in templates {
        if let Some(parent_index) = template.parent_index {
            let parent: & BodyState = &states[parent_index];
            let orbital_speed = (G * (parent.mass + template.mass) / template.orbit_radius).sqrt()
                * template.orbit_speed_multiplier;

            let local_position = rotate_x(
                [
                    template.orbit_radius * template.phase.cos(),
                    0.0,
                    template.orbit_radius * template.phase.sin(),
                ],
                template.inclination,
            );
            let local_velocity = rotate_x(
                [
                    -orbital_speed * template.phase.sin(),
                    0.0,
                    orbital_speed * template.phase.cos(),
                ],
                template.inclination,
            );

            states.push(BodyState {
                mass: template.mass,
                position: [
                    parent.position[0] + local_position[0],
                    parent.position[1] + local_position[1],
                    parent.position[2] + local_position[2],
                ],
                velocity: [
                    parent.velocity[0] + local_velocity[0],
                    parent.velocity[1] + local_velocity[1],
                    parent.velocity[2] + local_velocity[2],
                ],
            });
        } else {
            states.push(BodyState {
                mass: template.mass,
                position: [0.0, 0.0, 0.0],
                velocity: [0.0, 0.0, 0.0],
            });
        }
    }

    states
}

fn rotate_x(vector: [f64; 3], angle: f64) -> [f64; 3] {
    let cos_angle = angle.cos();
    let sin_angle = angle.sin();

    [
        vector[0],
        vector[1] * cos_angle - vector[2] * sin_angle,
        vector[1] * sin_angle + vector[2] * cos_angle,
    ]
}

