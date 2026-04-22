

class WorkerList{

	constructor(){
		this.count = 0;
		this.list = [];
	}

}

let workers = new Map();

export class WorkerPool{
	constructor(){

	}

	static prewarm(url, params, count){
		if (!workers.has(url)){
			workers.set(url, new WorkerList());
		}

		let workerList = workers.get(url);
		let toCreate = count - workerList.count;
		for(let i = 0; i < toCreate; i++){
			let worker = new Worker(url, params);
			workerList.list.push(worker);
			workerList.count++;
		}

		// console.log(`pre-warmed ${toCreate} workers for ${url}`);
	}

	static getWorker(url, params){
		if (!workers.has(url)){
			workers.set(url, new WorkerList());
		}

		let workerList = workers.get(url);
		if (workerList.list.length === 0){
			let worker = new Worker(url, params);
			workerList.list.push(worker);
			workerList.count++;
		}

		let worker = workerList.list.pop();

		return worker;
	}

	static getWorkerCount(url){
		if (!workers.has(url)){
			return 0;
		}else{
			return workers.get(url).count;
		}
	}

	static getAvailableWorkerCount(url){
		if (!workers.has(url)){
			return Infinity;
		}else{
			return workers.get(url).list.length;
		}
	}

	static returnWorker(url, worker){
		workers.get(url).list.push(worker);
	}

	// Terminate a checked-out worker and drop it from the pool entirely
	static discardWorker(url, worker){
		worker.terminate();
		if(workers.has(url)){
			workers.get(url).count--;
		}
	}
	
};