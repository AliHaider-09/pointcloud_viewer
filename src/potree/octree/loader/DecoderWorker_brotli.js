
import {BrotliDecode} from "../../../../libs/brotli/decode.js";

class Stats{
	constructor(){
		this.name = "";
		this.min = null;
		this.max = null;
		this.mean = null;
	}
};

function dealign24b(mortoncode){
	// see https://stackoverflow.com/questions/45694690/how-i-can-remove-all-odds-bits-in-c

	// input alignment of desired bits
	// ..a..b..c..d..e..f..g..h..i..j..k..l..m..n..o..p
	let x = mortoncode;

	//          ..a..b..c..d..e..f..g..h..i..j..k..l..m..n..o..p                     ..a..b..c..d..e..f..g..h..i..j..k..l..m..n..o..p 
	//          ..a.....c.....e.....g.....i.....k.....m.....o...                     .....b.....d.....f.....h.....j.....l.....n.....p 
	//          ....a.....c.....e.....g.....i.....k.....m.....o.                     .....b.....d.....f.....h.....j.....l.....n.....p 
	x = ((x & 0b001000001000001000001000) >>  2) | ((x & 0b000001000001000001000001) >> 0);
	//          ....ab....cd....ef....gh....ij....kl....mn....op                     ....ab....cd....ef....gh....ij....kl....mn....op
	//          ....ab..........ef..........ij..........mn......                     ..........cd..........gh..........kl..........op
	//          ........ab..........ef..........ij..........mn..                     ..........cd..........gh..........kl..........op
	x = ((x & 0b000011000000000011000000) >>  4) | ((x & 0b000000000011000000000011) >> 0);
	//          ........abcd........efgh........ijkl........mnop                     ........abcd........efgh........ijkl........mnop
	//          ........abcd....................ijkl............                     ....................efgh....................mnop
	//          ................abcd....................ijkl....                     ....................efgh....................mnop
	x = ((x & 0b000000001111000000000000) >>  8) | ((x & 0b000000000000000000001111) >> 0);
	//          ................abcdefgh................ijklmnop                     ................abcdefgh................ijklmnop
	//          ................abcdefgh........................                     ........................................ijklmnop
	//          ................................abcdefgh........                     ........................................ijklmnop
	x = ((x & 0b000000000000000000000000) >> 16) | ((x & 0b000000000000000011111111) >> 0);

	// sucessfully realigned! 
	//................................abcdefghijklmnop

	return x;
}

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

	let {name, pointAttributes, numPoints, scale, offset, min, nodeMin, nodeMax} = event.data;

	if(numPoints === 0) return {buffer: new ArrayBuffer(0)};

	let buffer;
	if(event.data.byteSize === 0){
		buffer = new ArrayBuffer(0);
		console.warn(`loaded node with 0 bytes: ${name}`);
	}else{
		let {url, byteOffset, byteSize} = event.data;
		buffer = await fetchNode(url, byteOffset, byteSize, signal);
	}

	let tStart = performance.now();

	let decoded = BrotliDecode(new Int8Array(buffer));
	let view = new DataView(decoded.buffer);

	let outByteSize = pointAttributes.byteSize * numPoints;
	let alignedOutByteSize = outByteSize + (4 - (outByteSize % 4));
	let outBuffer = new ArrayBuffer(alignedOutByteSize);
	let outView = new DataView(outBuffer);
	let outUint8 = new Uint8Array(outBuffer);
	let srcUint8 = new Uint8Array(decoded.buffer);

	// Pre-compute scale+offset constants
	let s0 = scale[0], s1 = scale[1], s2 = scale[2];
	let o0 = offset[0] - min[0], o1 = offset[1] - min[1], o2 = offset[2] - min[2];

	let sourceByteOffset = 0;
	let targetByteOffset = 0;
	for (let pointAttribute of pointAttributes.attributes) {

		if(["POSITION_CARTESIAN", "position"].includes(pointAttribute.name)){

			for (let j = 0; j < numPoints; j++) {
				let pointOffset = sourceByteOffset + j * 16;

				let mc_0 = view.getUint32(pointOffset +  4, true);
				let mc_1 = view.getUint32(pointOffset +  0, true);
				let mc_2 = view.getUint32(pointOffset + 12, true);
				let mc_3 = view.getUint32(pointOffset +  8, true);

				// Pre-compute shared dealign inputs
				let mc3_lo = mc_3 & 0x00FFFFFF;
				let mc3_hi = ((mc_3 >>> 24) | (mc_2 << 8)) >>> 0;

				let X = dealign24b(mc3_lo >>> 0) | (dealign24b(mc3_hi >>> 0) << 8);
				let Y = dealign24b(mc3_lo >>> 1) | (dealign24b(mc3_hi >>> 1) << 8);
				let Z = dealign24b(mc3_lo >>> 2) | (dealign24b(mc3_hi >>> 2) << 8);

				if(mc_1 != 0 || mc_2 != 0){
					let mc1_lo = mc_1 & 0x00FFFFFF;
					let mc1_hi = ((mc_1 >>> 24) | (mc_0 << 8)) >>> 0;

					X = X | (dealign24b(mc1_lo >>> 0) << 16) | (dealign24b(mc1_hi >>> 0) << 24);
					Y = Y | (dealign24b(mc1_lo >>> 1) << 16) | (dealign24b(mc1_hi >>> 1) << 24);
					Z = Z | (dealign24b(mc1_lo >>> 2) << 16) | (dealign24b(mc1_hi >>> 2) << 24);
				}

				let targetOffset = targetByteOffset + 12 * j;
				outView.setFloat32(targetOffset + 0, X * s0 + o0, true);
				outView.setFloat32(targetOffset + 4, Y * s1 + o1, true);
				outView.setFloat32(targetOffset + 8, Z * s2 + o2, true);
			}

			sourceByteOffset += 16 * numPoints;
			targetByteOffset += 12 * numPoints;
		}else if(["RGBA", "rgba"].includes(pointAttribute.name)){

			for (let j = 0; j < numPoints; j++) {
				let pointOffset = sourceByteOffset + j * 8;

				let mc_0 = view.getUint32(pointOffset +  4, true);
				let mc_1 = view.getUint32(pointOffset +  0, true);

				let mc1_lo = mc_1 & 0x00FFFFFF;
				let mc1_hi = ((mc_1 >>> 24) | (mc_0 << 8)) >>> 0;

				let r = dealign24b(mc1_lo >>> 0) | (dealign24b(mc1_hi >>> 0) << 8);
				let g = dealign24b(mc1_lo >>> 1) | (dealign24b(mc1_hi >>> 1) << 8);
				let b = dealign24b(mc1_lo >>> 2) | (dealign24b(mc1_hi >>> 2) << 8);

				r = r > 255 ? r / 256 : r;
				g = g > 255 ? g / 256 : g;
				b = b > 255 ? b / 256 : b;

				let targetOffset = targetByteOffset + 6 * j;
				outView.setUint16(targetOffset + 0, r, true);
				outView.setUint16(targetOffset + 2, g, true);
				outView.setUint16(targetOffset + 4, b, true);
			}

			sourceByteOffset += 8 * numPoints;
			targetByteOffset += 6 * numPoints;
		}else{

			// Bulk copy using TypedArray instead of byte-by-byte
			let attrSize = pointAttribute.byteSize;
			for (let j = 0; j < numPoints; j++) {
				let srcOff = sourceByteOffset + j * attrSize;
				let dstOff = targetByteOffset + j * attrSize;
				outUint8.set(srcUint8.subarray(srcOff, srcOff + attrSize), dstOff);
			}

			sourceByteOffset += numPoints * attrSize;
			targetByteOffset += numPoints * attrSize;
		}

	}


	let statsList = new Array();
	if(name === "r")
	{ // compute stats

		// debugger;

		let outView = new DataView(outBuffer);

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


	// {
	// 	let millies = performance.now() - tStart;
	// 	let seconds = millies / 1000;

	// 	let pointsPerSec = numPoints / seconds;
	// 	let strPointsPerSec = (pointsPerSec / 1_000_000).toFixed(2);

	// 	console.log(`read ${numPoints.toLocaleString()} points in ${millies.toFixed(1)}ms. (${strPointsPerSec} million points / s`);
	// }


	return {
		buffer: outBuffer, statsList
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
