
import {Vector3, Matrix4, Box3} from "potree";
import {Potree, EventDispatcher} from "potree";

export class PotreeControls{

	constructor(element){

		this.element = element;
		this.radius = 5;
		this.yaw = 0;
		this._pitch = 0;
		// this.pitch = 0;
		this.pivot = new Vector3();
		this.world = new Matrix4();
		this.dispatcher = new EventDispatcher();
		this.pickPosition = null;
		this.dragStart = null;

		this.pitch_limits = [
			0.8 * -Math.PI / 2, 
			0.8 * Math.PI / 2
		];

		// this.dispatcher.add("keydown", e => {
		// 	console.log(e);
		// });

		this.dispatcher.add("mousedown", e => {
			this.dragStart = {
				position: this.getPosition().clone(),
				pick: this.pickPosition?.clone(),
				target: this.pivot.clone(),
				yaw: this.yaw,
				pitch: this.pitch,
				ratius: this.radius,
			};
		});

		this.dispatcher.add("mouseup", e => {
			this.dragStart = null;
		});

		this.dispatcher.add("mousemove", e => {

			let dragLeft = e.event.buttons === 1;
			let dragRight = e.event.buttons === 2;

			if(dragLeft){
				let diffX = e.event.movementX;
				let diffY = e.event.movementY;

				let ux = diffX / this.element.width;
				let uy = diffY / this.element.height;

				this.yaw += 6 * ux;
				this.pitch += 6 * uy;
			}else if(dragRight){
				let diffX = e.event.movementX;
				let diffY = e.event.movementY;

				let ux = diffX / this.element.width;
				let uy = diffY / this.element.height;

				if(this.dragStart){
					let extent = this.dragStart.position.distanceTo(this.dragStart.target);

					this.translate_local(-ux * extent, 0, uy * extent);
				}
			}else{
				if(Potree.hoveredItem){
					this.setPickPosition(Potree.pickPosition);
				}
				// this.pickPosition = Potree.pickPosition;
			}

		});

		// Touch: 1-finger orbit, 2-finger pan + pinch zoom
		this.lastTouches = null;

		this.dispatcher.add("touchstart", e => {
			let touches = e.touches;
			if(touches.length === 1){
				this.lastTouches = [{x: touches[0].pageX, y: touches[0].pageY}];
				this.dragStart = {
					position: this.getPosition().clone(),
					pick: this.pickPosition?.clone(),
					target: this.pivot.clone(),
					yaw: this.yaw,
					pitch: this.pitch,
					radius: this.radius,
				};
			}else if(touches.length === 2){
				this.lastTouches = [
					{x: touches[0].pageX, y: touches[0].pageY},
					{x: touches[1].pageX, y: touches[1].pageY},
				];
			}
		});

		this.dispatcher.add("touchend", e => {
			this.lastTouches = null;
			this.dragStart = null;
		});

		this.dispatcher.add("touchmove", e => {
			let touches = e.touches;

			if(touches.length === 1 && this.lastTouches?.length === 1){
				// 1-finger: orbit
				let dx = touches[0].pageX - this.lastTouches[0].x;
				let dy = touches[0].pageY - this.lastTouches[0].y;

				let ux = dx / this.element.width;
				let uy = dy / this.element.height;

				this.yaw += 6 * ux;
				this.pitch += 6 * uy;

				this.lastTouches = [{x: touches[0].pageX, y: touches[0].pageY}];
			}else if(touches.length === 2 && this.lastTouches?.length === 2){
				// 2-finger: pan + pinch zoom
				let prevMidX = (this.lastTouches[0].x + this.lastTouches[1].x) / 2;
				let prevMidY = (this.lastTouches[0].y + this.lastTouches[1].y) / 2;
				let currMidX = (touches[0].pageX + touches[1].pageX) / 2;
				let currMidY = (touches[0].pageY + touches[1].pageY) / 2;

				let dx = currMidX - prevMidX;
				let dy = currMidY - prevMidY;

				let ux = dx / this.element.width;
				let uy = dy / this.element.height;

				let extent = this.radius;
				this.translate_local(-ux * extent, 0, uy * extent);

				// Pinch zoom
				let prevDist = Math.hypot(
					this.lastTouches[1].x - this.lastTouches[0].x,
					this.lastTouches[1].y - this.lastTouches[0].y
				);
				let currDist = Math.hypot(
					touches[1].pageX - touches[0].pageX,
					touches[1].pageY - touches[0].pageY
				);

				if(prevDist > 0){
					let scale = prevDist / currDist;
					this.radius *= scale;
				}

				this.lastTouches = [
					{x: touches[0].pageX, y: touches[0].pageY},
					{x: touches[1].pageX, y: touches[1].pageY},
				];
			}
		});

		this.dispatcher.add("mousewheel", e => {
			let diff = -Math.sign(e.delta);

			{
				let campos = this.getPosition();
				let targetpos = this.pickPosition;

				if(!targetpos) return;

				let distance = campos.distanceTo(targetpos);
				
				let newDistance = 0;
				if(diff >= 0){
					newDistance = distance * 1.1;
				}else if(diff < 0){
					newDistance = distance / 1.1;
				}

				let movedir = targetpos.clone().sub(campos).normalize();
				let movedist = distance - newDistance;
				let movevec = movedir.clone().multiplyScalar(movedist);
				let newCampos = campos.clone().add(movevec);
				let newRadius = newDistance * this.radius / distance;

				let camdir = this.pivot.clone().sub(campos).normalize();
				let newPivot = newCampos.clone().add(camdir.clone().multiplyScalar(newRadius));

				this.set({
					pivot: newPivot,
					radius: newRadius,
				});
			}

			this.update(0);
			

		});
	}

	setPickPosition(position){
		this.pickPosition = position;

		let origin = this.getPosition();
		let pick_dir = this.pickPosition.clone().sub(origin).normalize();
		let pick_dist = origin.distanceTo(this.pickPosition);
		let pivot_dir = this.pivot.clone().sub(origin).normalize();
		let pivot_dist = origin.distanceTo(this.pivot);
		let origin_pick = this.pickPosition.clone().sub(origin);

		let newRadius = pick_dir.dot(origin_pick);
		let newPivot = pivot_dir.clone().multiplyScalar(newRadius).add(origin);

		this.set({position: origin, pivot: newPivot});



	}

	set({yaw, pitch, radius, pivot, position}){

		this.yaw = yaw ?? this.yaw;
		this.pitch = pitch ?? this.pitch;
		this.radius = radius ?? this.radius;

		if(pivot){
			if(typeof pivot.x !== "undefined"){
				this.pivot.copy(pivot);
			}else{
				this.pivot.set(...pivot);
			}
		}
		
		if(position !== undefined && pivot !== undefined){

			if(position.constructor.name === "Array"){
				position = new Vector3(...position);
			}
			if(pivot.constructor.name === "Array"){
				pivot = new Vector3(...pivot);
			}

			let diff = new Vector3(
				pivot.x - position.x,
				pivot.y - position.y,
				pivot.z - position.z,
			);

			let radius = diff.length();
			let yaw = Math.PI / 2 - Math.atan2(diff.y, diff.x);
			let groundRadius = Math.sqrt(diff.x ** 2 + diff.y ** 2);
			let pitch = -Math.atan2(diff.z, groundRadius);

			this.yaw = yaw;
			this.pitch = pitch;
			this.radius = radius;
		} 

		// this.update(0);
	}

	get pitch(){
		return this._pitch;
	}

	set pitch(value){

		value = Math.max(value, this.pitch_limits[0]);
		value = Math.min(value, this.pitch_limits[1]);

		this._pitch = value;
	}


	zoomTo(node, args = {}){

		let box = new Box3();
		let tmp = new Box3();
		node.traverse((node) => {

			let childBox = node.boundingBox;

			if(!childBox.isFinite()){
				return;
			}

			tmp.copy(childBox);
			tmp.applyMatrix4(node.world);
			
			box.expandByBox(tmp);
		});

		let pivot = box.center();
		let multiplier = args.zoom ?? 1.0;
		let radius = box.size().length() * 0.8 * multiplier;

		this.set({pivot, radius});

	}

	getPosition(){
		return new Vector3().applyMatrix4(this.world);
	}

	translate_local(x, y, z){
		let _pos = new Vector3(0, 0, 0);
		let _right = new Vector3(1, 0, 0);
		let _forward = new Vector3(0, 1, 0);
		let _up = new Vector3(0, 0, 1);
		
		_pos.applyMatrix4(this.world);
		_right.applyMatrix4(this.world);
		_forward.applyMatrix4(this.world);
		_up.applyMatrix4(this.world);

		_right.sub(_pos).normalize();
		_forward.sub(_pos).normalize();
		_up.sub(_pos).normalize();

		_right.multiplyScalar(x);
		_forward.multiplyScalar(z);
		_up.multiplyScalar(-y);

		this.pivot.add(_right);
		this.pivot.add(_forward);
		this.pivot.add(_up);
	}

	update(delta){

		let flip = new Matrix4().set(
			1, 0, 0, 0,
			0, 0, 1, 0,
			0, -1, 0, 0,
			0, 0, 0, 1,
		);

		// WASD movement disabled in orbit mode — use First Person View (F key) for WASD navigation

		this.world.makeIdentity();
		this.world.translate(0, 0, this.radius);
		this.world.multiplyMatrices(flip, this.world);
		this.world.rotate(Math.PI / 2 - this.pitch, new Vector3(1, 0, 0));
		this.world.rotate(-this.yaw, new Vector3(0, 1, 0));

		this.world.translate(this.pivot.x, this.pivot.z, -this.pivot.y);

		{
			let flip = new Matrix4().set(
				1, 0, 0, 0,
				0, 0, -1, 0,
				0, 1, 0, 0,
				0, 0, 0, 1,
			);

			this.world.multiplyMatrices(flip, this.world);
		}

	}

	toExpression(){

		let pivot = this.pivot;

		let str = `;
		controls.set(
			yaw: ${this.yaw},
			pitch: ${this.pitch},
			radius: ${this.radius},
			pivot: new Vector3(${pivot.x}, ${pivot.y}, ${pivot.z}),
		);
		`;

		return str;
	}



};