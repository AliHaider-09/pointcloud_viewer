
class Stats{
	constructor(){
		this.name = "";
		this.min = null;
		this.max = null;
		this.mean = null;
	}
};

const typedArrayMapping = {
	"int8":   Int8Array,
	"int16":  Int16Array,
	"int32":  Int32Array,
	"int64":  Float64Array,
	"uint8":  Uint8Array,
	"uint16": Uint16Array,
	"uint32": Uint32Array,
	"uint64": Float64Array,
	"float":  Float32Array,
	"double": Float64Array,
};

async function fetchNode(url, byteOffset, byteSize, signal){
	let response = await fetch(url, {
		headers: {
			'Range': `bytes=${byteOffset}-${byteOffset + byteSize - 1}`,
		},
		signal,
	});
	return await response.arrayBuffer();
}

async function load(event, signal){

	let {name, pointAttributes, numPoints, scale, offset, min} = event.data;

	let buffer;
	if(event.data.byteSize === 0){
		buffer = new ArrayBuffer(0);
	}else if(event.data.nodeBuffer){
		// Use pre-fetched buffer passed from main thread
		buffer = event.data.nodeBuffer;
	}else{
		let {url, byteOffset, byteSize} = event.data;
		buffer = await fetchNode(url, byteOffset, byteSize, signal);
	}


	let tStart = performance.now();

	buffer = new Uint8Array(buffer);
	let view = new DataView(buffer.buffer);

	// pad to multiple of 4 bytes due to GPU requirements.
	let alignedSize = buffer.byteLength + (4 - (buffer.byteLength % 4));
	let targetBuffer = new ArrayBuffer(alignedSize);
	let targetView = new DataView(targetBuffer);

	// debugger;

	let byteOffset = 0;
	let targetUint8 = new Uint8Array(targetBuffer);
	let s0 = scale[0], s1 = scale[1], s2 = scale[2];
	let o0 = offset[0] - min[0], o1 = offset[1] - min[1], o2 = offset[2] - min[2];
	let bps = pointAttributes.byteSize;

	for (let pointAttribute of pointAttributes.attributes) {

		if(["POSITION_CARTESIAN", "position"].includes(pointAttribute.name)){

			let targetBase = numPoints * byteOffset;
			for (let j = 0; j < numPoints; j++) {
				let pointOffset = j * bps + byteOffset;

				let X = view.getInt32(pointOffset + 0, true);
				let Z = view.getInt32(pointOffset + 4, true);
				let Y = view.getInt32(pointOffset + 8, true);

				let targetOffset = targetBase + j * 12;
				targetView.setFloat32(targetOffset + 0, X * s0 + o0, true);
				targetView.setFloat32(targetOffset + 4, Z * s2 + o2, true);
				targetView.setFloat32(targetOffset + 8, Y * s1 + o1, true);
			}
		}else{

			// Bulk copy: gather attribute bytes from interleaved source into contiguous target
			let attrSize = pointAttribute.byteSize;
			let targetBase = numPoints * byteOffset;
			for (let j = 0; j < numPoints; j++) {
				let srcOff = j * bps + byteOffset;
				let dstOff = targetBase + j * attrSize;
				targetUint8.set(buffer.subarray(srcOff, srcOff + attrSize), dstOff);
			}

		}

		byteOffset += pointAttribute.byteSize;
	}

	let statsList = new Array();
	if(name === "r")
	{ // compute stats

		let outView = new DataView(targetBuffer);

		let attributesByteSize = 0;
		for(let i = 0; i < pointAttributes.attributes.length; i++){
			let attribute = pointAttributes.attributes[i];
			
			let stats = new Stats();
			stats.name = attribute.name;

			if(attribute.numElements === 1){
				stats.min = Infinity;
				stats.max = -Infinity;
				stats.mean = 0;
			}else{
				stats.min = new Array(attribute.numElements).fill(Infinity);
				stats.max = new Array(attribute.numElements).fill(-Infinity);
				stats.mean = new Array(attribute.numElements).fill(0);
			}

			let readValue = null;
			let offset_to_first = numPoints * attributesByteSize;

			let reader = {
				"uint8"    : outView.getUint8.bind(outView),
				"uint16"   : outView.getUint16.bind(outView),
				"uint32"   : outView.getUint32.bind(outView),
				"int8"     : outView.getInt8.bind(outView),
				"int16"    : outView.getInt16.bind(outView),
				"int32"    : outView.getInt32.bind(outView),
				"float"    : outView.getFloat32.bind(outView),
				"double"   : outView.getFloat64.bind(outView),
			}[attribute.type.name];

			let elementByteSize = attribute.byteSize / attribute.numElements;
			if(reader){
				readValue = (index, element) => reader(offset_to_first + index * attribute.byteSize + element * elementByteSize, true);
			}

			if(["XYZ", "position"].includes(attribute.name)){
				readValue = (index, element) => {

					let v = outView.getFloat32(offset_to_first + index * attribute.byteSize + element * 4, true);
					v = v + min[element];

					return v;
				}
			}

			if(readValue !== null){

				if(attribute.numElements === 1){
					for(let i = 0; i < numPoints; i++){

						let value = readValue(i, 0);

						stats.min = Math.min(stats.min, value);
						stats.max = Math.max(stats.max, value);
						stats.mean = stats.mean + value;
					}

					stats.mean = stats.mean / numPoints;
				}else{
					for(let i = 0; i < numPoints; i++){
						
						for(let j = 0; j < attribute.numElements; j++){
							let value = readValue(i, j);

							stats.min[j] = Math.min(stats.min[j], value);
							stats.max[j] = Math.max(stats.max[j], value);
							stats.mean[j] += value;
						}
					}

					for(let j = 0; j < attribute.numElements; j++){
						stats.mean[j] = stats.mean[j] / numPoints;
					}
				}

				
			}

			statsList.push(stats);
			attributesByteSize += attribute.byteSize;
		}

	}

	// let duration = performance.now() - tStart;
	// let pointsPerSecond = (1000 * numPoints / duration) / 1_000_000;
	// console.log(`[${name}] duration: ${duration.toFixed(1)}ms, #points: ${numPoints}, points/s: ${pointsPerSecond.toFixed(1)}M`);

	return {
		buffer: targetBuffer, statsList
	};
}

let currentAbort = null;

onmessage = async function (event) {

	if(event.data === "cancel"){
		if(currentAbort) currentAbort.abort();
		return;
	}

	let abort = new AbortController();
	currentAbort = abort;

	try{
		let loaded = await load(event, abort.signal);

		let message = loaded;

		let transferables = [];

		transferables.push(loaded.buffer);

		postMessage(message, transferables);
	}catch(e){
		if(e.name === "AbortError"){
			postMessage("cancelled");
		}else{
			console.log(e);
			postMessage("failed");
		}
	}finally{
		currentAbort = null;
	}


};
