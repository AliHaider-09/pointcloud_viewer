
import {Vector3, Matrix4} from "potree";
import {Potree, EventDispatcher} from "potree";

export class FirstPersonControls{

	constructor(element){

		this.element = element;
		this.yaw = 0;
		this._pitch = 0;
		this.position = new Vector3();
		this.pivot = new Vector3(); // kept for compatibility with init.js camTarget display
		this.world = new Matrix4();
		this.dispatcher = new EventDispatcher();

		this.moveSpeed = 5.0; // base units/sec
		this.lookSensitivity = 4.0;
		this.sprintMultiplier = 3.0;
		this.slowMultiplier = 0.2;
		this._initialized = false; // true after first seed from orbit

		this.pitch_limits = [
			-0.85 * Math.PI / 2,
			0.85 * Math.PI / 2,
		];

		// Crosshair element
		this.elCrosshair = document.createElement("div");
		this.element.parentElement.append(this.elCrosshair);
		Object.assign(this.elCrosshair.style, {
			position: "absolute",
			top: "50%",
			left: "50%",
			transform: "translate(-50%, -50%)",
			width: "24px",
			height: "24px",
			pointerEvents: "none",
			zIndex: "1000",
			display: "none",
		});
		this.elCrosshair.innerHTML = `
			<svg width="24" height="24" viewBox="0 0 24 24">
				<circle cx="12" cy="12" r="3" fill="none" stroke="white" stroke-width="1.5" opacity="0.8"/>
				<line x1="12" y1="0" x2="12" y2="7" stroke="white" stroke-width="1.5" opacity="0.6"/>
				<line x1="12" y1="17" x2="12" y2="24" stroke="white" stroke-width="1.5" opacity="0.6"/>
				<line x1="0" y1="12" x2="7" y2="12" stroke="white" stroke-width="1.5" opacity="0.6"/>
				<line x1="17" y1="12" x2="24" y2="12" stroke="white" stroke-width="1.5" opacity="0.6"/>
			</svg>
		`;

		// Mode indicator HUD
		this.elHud = document.createElement("div");
		this.element.parentElement.append(this.elHud);
		Object.assign(this.elHud.style, {
			position: "fixed",
			top: "10px",
			left: "calc(50% + 145px)",
			transform: "translateX(-50%)",
			color: "white",
			fontSize: "13px",
			fontFamily: "'Poppins', 'Segoe UI', system-ui, sans-serif",
			padding: "10px 20px",
			background: "rgba(0, 0, 0, 0.6)",
			borderRadius: "8px",
			pointerEvents: "none",
			zIndex: "10000",
			display: "none",
			textAlign: "center",
			textShadow: "0 1px 3px black",
		});
		this.elHud.innerHTML = `
			<b style="font-size: 15px;">First Person View</b>
			<div style="font-size: 11px; opacity: 0.9; margin-top: 6px; display: flex; flex-wrap: wrap; gap: 4px 14px; justify-content: center;">
				<span><span style="color: #ffcc00; font-weight: 600;">Left-click drag</span> Look</span>
				<span><span style="color: #ffcc00; font-weight: 600;">WASD</span> Move</span>
				<span><span style="color: #ffcc00; font-weight: 600;">Space/C</span> Up/Down</span>
				<span><span style="color: #ffcc00; font-weight: 600;">Shift+WASD</span> Sprint</span>
				<span><span style="color: #ffcc00; font-weight: 600;">Q+WASD</span> Slow</span>
				<span><span style="color: #ffcc00; font-weight: 600;">Scroll Up</span> Faster</span>
				<span><span style="color: #ffcc00; font-weight: 600;">Scroll Down</span> Slower</span>
				<span><span style="color: #ffcc00; font-weight: 600;">F</span> Exit</span>
			</div>
		`;

		// Mouse look
		this.dispatcher.add("mousemove", e => {
			let dragLeft = e.event.buttons === 1;

			if(dragLeft){
				let diffX = e.event.movementX;
				let diffY = e.event.movementY;

				let ux = diffX / this.element.width;
				let uy = diffY / this.element.height;

				this.yaw += this.lookSensitivity * ux;
				this.pitch += this.lookSensitivity * uy;
			}
		});

		// Scroll to adjust move speed
		this.dispatcher.add("mousewheel", e => {
			let diff = -Math.sign(e.delta);

			if(diff > 0){
				this.moveSpeed *= 1.2;
			}else if(diff < 0){
				this.moveSpeed /= 1.2;
			}

			// Clamp to reasonable range
			this.moveSpeed = Math.max(0.1, Math.min(this.moveSpeed, 500));
		});

		this.dispatcher.add("focused", e => {
			this.elCrosshair.style.display = "block";
			this.elHud.style.display = "block";
		});

		this.dispatcher.add("unfocused", e => {
			this.elCrosshair.style.display = "none";
			this.elHud.style.display = "none";
		});
	}

	get pitch(){
		return this._pitch;
	}

	set pitch(value){
		value = Math.max(value, this.pitch_limits[0]);
		value = Math.min(value, this.pitch_limits[1]);
		this._pitch = value;
	}

	// Seed FPV state from an orbit controller's current world matrix (only on first switch)
	setFromOrbitControls(orbitControls){
		// If already initialized, keep the saved FPV position
		if(this._initialized) return;

		// Extract camera position from the orbit world matrix
		let pos = new Vector3(0, 0, 0).applyMatrix4(orbitControls.world);
		this.position.copy(pos);

		// Extract forward direction (camera looks down -Z in local space)
		let target = new Vector3(0, 0, -1).applyMatrix4(orbitControls.world);
		let forward = target.clone().sub(pos).normalize();

		// Derive yaw and pitch from the forward vector
		// In the scene coordinate system: X=east, Y=north, Z=up
		this.yaw = Math.PI / 2 - Math.atan2(forward.y, forward.x);
		let groundLen = Math.sqrt(forward.x * forward.x + forward.y * forward.y);
		this.pitch = -Math.atan2(forward.z, groundLen);

		// Auto-scale move speed from the orbit radius
		if(orbitControls.radius !== undefined){
			this.moveSpeed = orbitControls.radius * 0.5;
			this.moveSpeed = Math.max(0.5, Math.min(this.moveSpeed, 200));
		}

		this._initialized = true;
	}

	set({yaw, pitch, position}){
		this.yaw = yaw ?? this.yaw;
		this.pitch = pitch ?? this.pitch;

		if(position){
			if(typeof position.x !== "undefined"){
				this.position.copy(position);
			}else{
				this.position.set(...position);
			}
		}
	}

	zoomTo(node, args = {}){
		// In FPV, "zoom to" means teleport near the node and look at it
		let box;
		if(node.getBoundingBoxWorld){
			box = node.getBoundingBoxWorld();
		}else{
			box = node.boundingBox;
		}

		let center = box.center();
		let size = box.size().length();
		let radius = size * 0.8 * (args.zoom ?? 1.0);

		// Place camera at a distance from center, looking toward it
		let forward = center.clone().sub(this.position).normalize();
		if(forward.length() < 0.001){
			forward.set(0, 1, 0);
		}

		this.position.copy(center).sub(forward.clone().multiplyScalar(radius));

		this.yaw = Math.PI / 2 - Math.atan2(forward.y, forward.x);
		let groundLen = Math.sqrt(forward.x * forward.x + forward.y * forward.y);
		this.pitch = -Math.atan2(forward.z, groundLen);

		this.moveSpeed = radius * 0.5;
		this.moveSpeed = Math.max(0.5, Math.min(this.moveSpeed, 200));
	}

	getPosition(){
		return this.position.clone();
	}

	// Build local direction vectors from yaw/pitch
	_getDirections(){
		// Forward direction on the ground plane (for WASD movement)
		let cosYaw = Math.cos(this.yaw);
		let sinYaw = Math.sin(this.yaw);
		let cosPitch = Math.cos(this.pitch);
		let sinPitch = Math.sin(this.pitch);

		// Scene coords: X=east, Y=north, Z=up
		// Yaw = rotation around Z; Pitch = tilt up/down
		// Forward = direction camera is looking projected onto ground for WASD
		// yaw = PI/2 - atan2(dy, dx), so forward = (sinYaw, cosYaw, 0)
		let forward = new Vector3(sinYaw, cosYaw, 0).normalize();
		let right = new Vector3(cosYaw, -sinYaw, 0).normalize();
		let up = new Vector3(0, 0, 1);

		// Full look direction (for the pivot/target point)
		let look = new Vector3(
			sinYaw * cosPitch,
			cosYaw * cosPitch,
			-sinPitch,
		).normalize();

		return {forward, right, up, look};
	}

	update(delta){
		// delta comes in as negative seconds from init.js
		let dt = Math.abs(delta);
		dt = Math.min(dt, 0.1); // clamp to avoid huge jumps

		let pressedKeys = Potree.instance.inputHandler.pressedKeys;

		// Speed modifiers
		let speed = this.moveSpeed;
		if(pressedKeys["ShiftLeft"] || pressedKeys["ShiftRight"]){
			speed *= this.sprintMultiplier;
		}
		if(pressedKeys["KeyQ"]){
			speed *= this.slowMultiplier;
		}

		let {forward, right, up, look} = this._getDirections();
		let advance = dt * speed;

		let moved = false;

		if(pressedKeys["KeyW"]){
			this.position.add(forward.clone().multiplyScalar(advance));
			moved = true;
		}
		if(pressedKeys["KeyS"]){
			this.position.add(forward.clone().multiplyScalar(-advance));
			moved = true;
		}
		if(pressedKeys["KeyA"]){
			this.position.add(right.clone().multiplyScalar(-advance));
			moved = true;
		}
		if(pressedKeys["KeyD"]){
			this.position.add(right.clone().multiplyScalar(advance));
			moved = true;
		}
		if(pressedKeys["Space"]){
			this.position.add(up.clone().multiplyScalar(advance));
			moved = true;
		}
		if(pressedKeys["KeyC"]){
			this.position.add(up.clone().multiplyScalar(-advance));
			moved = true;
		}

		// Update pivot to a point 1 unit in front of camera (for camTarget display)
		this.pivot.copy(this.position).add(look);

		// Build world matrix
		// The world matrix transforms from camera-local to world space.
		// Camera local: -Z = forward, +X = right, +Y = up
		// Scene: X = east, Y = north, Z = up
		let flip = new Matrix4().set(
			1, 0, 0, 0,
			0, 0, 1, 0,
			0, -1, 0, 0,
			0, 0, 0, 1,
		);

		this.world.makeIdentity();
		this.world.multiplyMatrices(flip, this.world);
		this.world.rotate(Math.PI / 2 - this.pitch, new Vector3(1, 0, 0));
		this.world.rotate(-this.yaw, new Vector3(0, 1, 0));
		this.world.translate(this.position.x, this.position.z, -this.position.y);

		{
			let flip2 = new Matrix4().set(
				1, 0, 0, 0,
				0, 0, -1, 0,
				0, 1, 0, 0,
				0, 0, 0, 1,
			);

			this.world.multiplyMatrices(flip2, this.world);
		}
	}

	toExpression(){
		let pos = this.position;

		let str = `;
		controls.set(
			yaw: ${this.yaw},
			pitch: ${this.pitch},
			position: new Vector3(${pos.x}, ${pos.y}, ${pos.z}),
		);
		`;

		return str;
	}

};
