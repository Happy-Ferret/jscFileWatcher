// spawned as ChromeWorker by DirectoryWatcherWorkerSubscript.js
const core = {
	os: {
		name: OS.Constants.Sys.Name.toLowerCase()
	}
};

// import paths
importScripts('../DirectoryWatcherPaths.js');
core.path = directorywatcher_paths;

// import Comm
importScripts(core.path.comm);

// import ostypes
importScripts(core.path.ostypes_dir + 'cutils.jsm');
importScripts(core.path.ostypes_dir + 'ctypes_math.jsm');
switch (core.os.name) {
	case 'winnt':
	case 'winmo':
	case 'wince':
		importScripts(core.path.ostypes_dir + 'ostypes_win.jsm');
		break
	case 'darwin':
		importScripts(core.path.ostypes_dir + 'ostypes_mac.jsm');
		break;
	default:
		// assume gtk based system OR android
		importScripts(core.path.ostypes_dir + 'ostypes_x11.jsm');
}

// Globals
var { callInMainworker } = CommHelper.childworker;

// Init
var gWkComm = new Comm.client.worker();

var gPipe;
var gNextSignalId = 0;
var path_mon_id_collection = {};
var gDWActive = {};
/*
	path: {
		all
			...
		win
			hdir
			o
			lp_index
			notif_buf
			signalid
			signalid_c
		mac
			cfstr - CFString of the path

		gio
			...
		inotify
			signalid
	}
*/

var SYSTEM_HAS_INOTIFY;

function init(aArg) {
	// var { pipe_ptrstr } = aArg;

	// test if system has inotify
	try {
		ostypes.API('inotify_init');
		SYSTEM_HAS_INOTIFY = true;
		if (!['winnt', 'wince', 'winmo', 'darwin', 'android'].includes(core.os.name)) {
			core.os.name = 'android'; // force inotify as gtk will never get here unless DirectoryWatcherWorkerSubscript found that inotify was supported
		}
	} catch (ex) {
		SYSTEM_HAS_INOTIFY = false;
	}

	// OS Specific Init
	switch (core.os.name) {
		case 'winnt':
		case 'winmo':
		case 'wince':

				var { pipe_ptrstr } = aArg;
				console.log('pipe_ptrstr:', pipe_ptrstr);

				// Globals
				gPipe = ostypes.TYPE.HANDLE(ctypes.UInt64(pipe_ptrstr));
				console.log('gPipe:', gPipe);
				gLpHandles = [gPipe];
				gLpHandles_c = ostypes.TYPE.HANDLE.array()(gLpHandles);
				// set up a watcher on a gPipe, send to mainthread the gPipe so it can interrupt

				// notification buffer size and length stuff
				WATCHED_RES_MAXIMUM_NOTIFICATIONS = 100; // 100; Dexter uses 100
				NOTIFICATION_BUFFER_SIZE_IN_BYTES = ostypes.TYPE.FILE_NOTIFY_INFORMATION.size * WATCHED_RES_MAXIMUM_NOTIFICATIONS;
				// we need it DWORD aligned - http://stackoverflow.com/a/29555298/1828637
				console.log('pre dword sized NOTIFICATION_BUFFER_SIZE_IN_BYTES:', NOTIFICATION_BUFFER_SIZE_IN_BYTES)
				while (NOTIFICATION_BUFFER_SIZE_IN_BYTES % ostypes.TYPE.DWORD.size) {
					NOTIFICATION_BUFFER_SIZE_IN_BYTES++;
				}
				NOTIFICATION_DWORD_BUFFER_LENGTH = NOTIFICATION_BUFFER_SIZE_IN_BYTES / ostypes.TYPE.DWORD.size;
				console.log('post dword sized NOTIFICATION_BUFFER_SIZE_IN_BYTES:', NOTIFICATION_BUFFER_SIZE_IN_BYTES, 'NOTIFICATION_DWORD_BUFFER_LENGTH:', NOTIFICATION_DWORD_BUFFER_LENGTH);

				DW_NOTIFY_FILTER = ostypes.CONST.FILE_NOTIFY_CHANGE_LAST_WRITE | ostypes.CONST.FILE_NOTIFY_CHANGE_FILE_NAME | ostypes.CONST.FILE_NOTIFY_CHANGE_DIR_NAME; // this is what @Dexter used
				winRoutine_c = ostypes.TYPE.FileIOCompletionRoutine.ptr(winRoutine);

			break;
		case 'darwin':

				gRunLoop = ostypes.API('CFRunLoopGetCurrent')();

				gCfHandles = []; // each element is the cfstr in gDWActive
				gCfHandles_c = null; // ostypes.TYPE.void.ptr.array()(gCfHandles);
				gCfHandles_cf = null; // ostypes.API('CFArrayCreate')(null, gCfHandles_c, gCfHandles.length, ostypes.CONST.kCFTypeArrayCallBacks.address());

				gStream = null;

				macRoutine_c = ostypes.TYPE.FSEventStreamCallback(macRoutine);

				return {
					runloop_ptrstr: cutils.strOfPtr(gRunLoop)
				};

			break;
		case 'android':

				// inotify
				var { pipe_read } = aArg;

				console.log('pipe_read:', pipe_read);
				gPipe = pipe_read;

				gFd = ostypes.API('inotify_init')();
				if (cutils.jscEqual(gFd, -1)) {
					console.error('Failed to create inotify instance, errno:', ctypes.errno);
					throw new Error('Failed to create inotify instance, errno: ' + ctypes.errno);
				}
				console.log('gFd:', gFd);

				INOTIFY_MASKS = ostypes.CONST.IN_ALL_EVENTS;

				gEINTRCnt = 0;
				self.addEventListener('close', function() {
					 var rez_close = ostypes.API('close')(gFd);
					 gFd = null;
					 if (cutils.jscEqual(rez_close, 0)) {
						 // succesfully closed
						 console.error('succesfully closed inotify fd, gFd');
					 } else {
						 // its -1
						console.error('Failed to close inotify instance, errno:', ctypes.errno);
						throw new Error('Failed to close inotify instance, errno: ' + ctypes.errno);
					 }
				}, false);

			break;
		default:
			// do nothing special

	}
}

// start functionality
function addPath(aArg) {
	// returns
		// true - successfully added
		// false - already there
		// undefined - error
	var { aPath } = aArg;

	var path_info = dwGetActiveInfo(aPath);

	if (path_info) {
		console.warn('already watching aPath:', aPath);
		return false;
	}

	switch (core.os.name) {
		case 'winnt':
		case 'winmo':
		case 'wince':
				var hdir = ostypes.API('CreateFile')(aPath, ostypes.CONST.FILE_LIST_DIRECTORY, ostypes.CONST.FILE_SHARE_READ | ostypes.CONST.FILE_SHARE_WRITE | ostypes.CONST.FILE_SHARE_DELETE, null, ostypes.CONST.OPEN_EXISTING, ostypes.CONST.FILE_FLAG_BACKUP_SEMANTICS | ostypes.CONST.FILE_FLAG_OVERLAPPED, null);
				var o = ostypes.TYPE.OVERLAPPED();

				var notif_buf = ostypes.TYPE.DWORD.array(NOTIFICATION_DWORD_BUFFER_LENGTH)(); //ostypes.TYPE.DWORD.array(NOTIFICATION_BUFFER_SIZE_IN_BYTES)(); // im not sure about the 4096 ive seen people use that and 2048 im not sure why
				console.info('notif_buf.constructor.size:', notif_buf.constructor.size, 'this SHOULD BE same as NOTIFICATION_BUFFER_SIZE_IN_BYTES:', NOTIFICATION_BUFFER_SIZE_IN_BYTES);
				if (notif_buf.constructor.size != NOTIFICATION_BUFFER_SIZE_IN_BYTES) {
					console.error('please email noitidart@gmail.com about this error. notif_buf is of a size i dont expect', 'notif_buf.constructor.size:', notif_buf.constructor.size, 'this SHOULD HAVE BEEN same as NOTIFICATION_BUFFER_SIZE_IN_BYTES:', NOTIFICATION_BUFFER_SIZE_IN_BYTES)
					startPoll();
					return undefined;
				}

				var signalid = gNextSignalId++;
				var signalid_c = ctypes.uint16_t(signalid);

				// hEvent is equivalent of user_data in Gio/Gtk
				o.hEvent = ctypes.cast(signalid_c.address(), ctypes.voidptr_t);

				// var lp_index = gLpHandles.length;
				// gLpHandles.push(hdir);
				// gLpHandles_c = ostypes.TYPE.HANDLE.array()(gLpHandles);

				var rez_rdc = ostypes.API('ReadDirectoryChanges')(hdir, notif_buf.address(), NOTIFICATION_BUFFER_SIZE_IN_BYTES, false, DW_NOTIFY_FILTER, null, o.address(), winRoutine_c);
				console.log('rez_rdc:', rez_rdc);

				if (!rez_rdc) {
					// failed to add due to error
					console.error('failed to add watcher due to error:', ctypes.winLastError);
					startPoll();
					return undefined;
				} else {
					// gDWActive[aPath] = { hdir, o, lp_index, notif_buf, signalid, signalid_c };
					gDWActive[aPath] = { hdir, o, notif_buf, signalid, signalid_c };
					startPoll();
					return true;
				}
			break;
		case 'darwin':

				var cfstr = ostypes.HELPER.makeCFStr(aPath);

				var new_cfhandles = [];
				for (var a_path in gDWActive) {
					var a_path_entry = gDWActive[a_path];
					new_cfhandles.push(a_path_entry.cfstr);
				}
				new_cfhandles.push(cfstr);

				var rez_reset = macResetStream(new_cfhandles);
				console.log('rez_reset:', rez_reset);

				if (rez_reset) {
					// ok succesfully added
					gDWActive[aPath] = { cfstr };
					startPoll();
					return true;
				} else {
					ostypes.API('CFRelease')(cfstr);
					return rez;
				}

			break;
		case 'android':

				var signalid = ostypes.API('inotify_add_watch')(gFd, aPath, INOTIFY_MASKS);
				if (cutils.jscEqual(signalid, -1)) {
					console.error('Failed to add path to inotify instance, errno:', ctypes.errno);
					startPoll();
					return undefined;
				}

				signalid = parseInt(cutils.jscGetDeepest(signalid));
				console.log('inotify added watch for path:', aPath, 'signalid:', signalid);

				gDWActive[aPath] = { signalid };

				startPoll();
				return true;

			break;
	}
}

function removePath(aArg) {
	// returns
		// true - successfully removed
		// false - wasnt there
		// undefined - error
	var { aPath } = aArg;

	console.log('poll worker - removePath, aPath:', aPath);

	var path_info = dwGetActiveInfo(aPath);
	if (!path_info) {
		console.warn('was not watching aPath:', aPath);
		startPoll();
		return false;
	}
	var path_entry = path_info.entry;

	switch (core.os.name) {
		case 'winnt':
		case 'winmo':
		case 'wince':

				var { hdir } = path_entry;

				// // stop watching this by removing it from gLpHandles/gLpHandles_c
				// // remove from gLpHandles
				// gLpHandles.splice(lp_index, 1);
				// gLpHandles_c = ostypes.TYPE.HANDLE.array()(gLpHandles);
				//
				// // decrement lp_index of all other paths that were above lp_index
				// for (var a_path in gDWActive) {
				// 	var a_path_entry = gDWActive[a_path];
				// 	if (a_path_entry.lp_index > lp_index) {
				// 		a_path_entry.lp_index--;
				// 	}
				// }

				// cancel apc
				var rez_cancelio = ostypes.API('CancelIo')(hdir); // dont need CancelIoEx as im in the same thread
				console.log('rez_cancelio:', rez_cancelio);

				if (!rez_cancelio) {
					// if fail here, its just bad for memory
					console.error('failed to cancelio on path:', aPath, 'due to error:', ctypes.winLastError);
					// it is still being watched
					startPoll();
					return undefined;
				} else {
					path_entry.removed = 'notyet'; // will be set by winRoutine in ERROR_OPERATION_ABORTED
					while (path_entry.removed == 'notyet') {
						var rez_sleep = ostypes.API('SleepEx')(ostypes.CONST.INFINITE, true);
						// the winRoutine for ERROR_OPERATION_ABORTED will trigger first, then the next line for console logging `rez_sleep` will happen
						console.log('rez_sleep:', rez_sleep);
					}

					if (!cutils.jscEqual(rez_sleep, ostypes.CONST.WAIT_IO_COMPLETION)) {
						console.error('rez_sleep is not WAIT_IO_COMPLETION! it is:', rez_sleep);
					}

					if (Object.keys(gDWActive).length) {
						startPoll();
					} else {
						console.log('poller worker - after cancel - not resuming poll as there are no pathts to watch');
						clearTimeout(gStartPollTimeout); // in case there is a left over from back to back `removePath`'s and the 2nd to last triggered a `startPoll()`
					}

					console.log('poll worker - removePath result:', path_entry.removed);
					return path_entry.removed;
				}
			break;
		case 'darwin':

				// create new array with all EXCEPT aPath entry
				var new_cfhandles = [];
				for (var a_path in gDWActive) {
					if (a_path != aPath) {
						var a_path_entry = gDWActive[a_path];
						new_cfhandles.push(a_path_entry.cfstr);
					}
				}

				if (new_cfhandles.length) {
					var rez_reset = macResetStream(new_cfhandles);

					if (rez_reset) {
						delete gDWActive[aPath];
						ostypes.API('CFRelease')(path_entry.cfstr);
					}

					startPoll();
					return rez_reset;
				} else {
					macReleaseGlobals();
					gCfHandles = [];

					console.log('not watching anymore paths so will not restart poll');

					return true;
				}

			break;
		case 'android':

				var { signalid } = path_entry;
				var rez_rm = ostypes.API('inotify_rm_watch')(gFd, signalid);
				if (cutils.jscEqual(signalid, -1)) {
					console.error('Failed to remove path from inotify instance, errno:', ctypes.errno);
					throw new Error('Failed to remove path from inotify instance, errno: ' + ctypes.errno);
				}

				delete gDWActive[aPath];

			break;
	}
}

function poll() {
	// console.log('poll entered');
	switch (core.os.name) {
		case 'winnt':
		case 'winmo':
		case 'wince':

				console.log('starting wait');
				var rez_wait = ostypes.API('WaitForMultipleObjectsEx')(gLpHandles.length, gLpHandles_c, false, ostypes.CONST.INFINITE, true);
				console.log('rez_wait:', rez_wait);
				// if (cutils.jscEqual(rez_wait, 0)) {
				// 	// its the gPipe interrupt, so dont restart the loop
				// } else {
				// 	// i get 192 when my file watcher triggers, dont restart poll here as it will keep returning with `1` or the index of the one that triggered, i have to reset the signal by calling ReadDirectoryChanges again
				// }
			break;
		case 'darwin':

				console.log('starting wait');
				ostypes.API('CFRunLoopRun')();
				console.log('wait done');

			break;
		case 'android':

				console.log('starting read');
				// // method: `read`
				// var buf = ostypes.TYPE.char.array(10 * ostypes.TYPE.inotify_event.size)(); // a single read can return an array of multiple elements, i set max to 10 elements of name with NAME_MAX, but its possible to get more then 10 returned as name may not be NAME_MAX in length for any/all of the returned's
				// var rez_wait = ostypes.API('read')(gPipe, buf, buf.constructor.size);

				// method: `poll`
				var fds = ostypes.TYPE.pollfd.array(2)();
				fds[0].fd = gPipe;
				fds[0].events = ostypes.CONST.POLLIN | ostypes.CONST.POLLERR | ostypes.CONST.POLLHUP;
				fds[1].fd = gFd;
				fds[1].events = ostypes.CONST.POLLIN | ostypes.CONST.POLLERR | ostypes.CONST.POLLHUP;
				var rez_wait = ostypes.API('poll')(fds, 2, -1); // -1 means block infinitely
				console.log('rez_wait:', rez_wait);

				// // method: `select`
				// var poll_fdset = new Uint8Array(128);
				// ostypes.HELPER.fd_set_set(poll_fdset, gFd);
				// ostypes.HELPER.fd_set_set(poll_fdset, gPipe);
				// var rez_wait = ostypes.API('select')(Math.max(gFd, gPipe) + 1, poll_fdset, null, null, null);

				if (cutils.jscEqual(rez_wait, -1)) {
					if (ctypes.errno === 4) {
						const eintr_retry_maxcnt = 100;
						const eintr_retry_inms = 500;
						// got EINTR - reloop till i dont get it - per http://stackoverflow.com/questions/28463350/why-does-select-keep-failing-with-eintr-errno?noredirect=1#comment64342712_28463350
						gEINTRCnt++;
						console.warn('got EINTR, will wait and try again, gEINTRCnt:', gEINTRCnt);
						if (gEINTRCnt === eintr_retry_maxcnt) {
							console.error('max retries for EINTR reached', eintr_retry_maxcnt, 'aborting');
							gEINTRCnt = 0;
						} else {
							startPoll(eintr_retry_inms);
						}
					} else {
						console.error('ABORTING, failed to read inotify buf, errno:', ctypes.errno);
					}
				} else {
					if (gEINTRCnt > 0) { console.error('took', gEINTRCnt, 'times to get over a EINTR'); }
					gEINTRCnt = 0;
					// method: read
					// var len = parseInt(cutils.jscGetDeepest(rez_wait));
					// console.log('read length:', len, 'and buf size:', buf.constructor.size, 'and inotify_event size:', ostypes.TYPE.inotify_event.size);

					// method: poll
					if (cutils.jscEqual(rez_wait, 0)) {
						// timed out, i should never get here, as i didnt implement timeout
					} else {
						if (!cutils.jscEqual(fds[1].revents, 0)) {
							// file change notification exists
							andRoutine();
						}

						if (!cutils.jscEqual(fds[0].revents, 0)) {
							// pipe was tripped, clear the pipe so future `select`/`poll` call with it will not return immediately
							var buf = ostypes.TYPE.char.array(20)(); // should only need 1 byte, but might have miltiple due to multi triggers
							var rez_read = buf.constructor.size;
							while (cutils.jscEqual(rez_read, buf.constructor.size)) {
								rez_read = ostypes.API('read')(gPipe, buf, buf.constructor.size);
								if (cutils.jscEqual(rez_read, -1)) {
									console.error('failed to clear pipe!! all future selects will return immediately so aborting! errno:', ctypes.errno);
									throw new Error('failed to clear pipe!! all future selects will return immediately so aborting!!');
								}
							}
						} else {
							// startPoll();
						}
					}
				}

			break;
	}
}

function macReleaseGlobals() {
	// release globals
	if (gCfHandles_c) { // on init or when 0 paths watched, gCfHandles_c and gCfHandles_cf is null
		// clean up the old handles
		ostypes.API('CFRelease')(gCfHandles_cf);
		gCfHandles_cf = null;
		gCfHandles_c = null;
	}
	if (gStream) {
		macReleaseStream(gStream, false);
		gStream = null;
	}
}

function macReleaseStream(aStream, aNotStarted) {

	ostypes.API('FSEventStreamUnscheduleFromRunLoop')(aStream, gRunLoop, ostypes.CONST.kCFRunLoopDefaultMode);

	if (!aNotStarted) {
		ostypes.API('FSEventStreamStop')(aStream);
	}

	ostypes.API('FSEventStreamInvalidate')(aStream);
	// just doing FSEventStreamStop and FSEventStreamInvalidate will make runLoopRun break but we want to totally clean up the stream as we dont want it anymore as we are making a new one
	ostypes.API('FSEventStreamRelease')(aStream);
}

function macResetStream(aNewCfHandles) {
	// aNewCfHandles is what you want gCfHandles on success
	// on success the globals are updated (gCfHandles, gCfHandles_c, gCfHandles_cf, gStream)

	// returns
		// true - success
		// false -
		// undefined - if error

	var rez;

	var new_cfhandles_c = ostypes.TYPE.void.ptr.array()(aNewCfHandles);
	var new_cfhandles_cf = ostypes.API('CFArrayCreate')(null, new_cfhandles_c, aNewCfHandles.length, ostypes.CONST.kCFTypeArrayCallBacks.address());
	if (new_cfhandles_cf.isNull()) {
		console.error('failed to create cf arr!');

		// clean up new_'s
		new_cfhandles_c = null;

		// return
		rez = undefined;
	} else {
		// create the new stream
		var new_stream = ostypes.API('FSEventStreamCreate')(ostypes.CONST.kCFAllocatorDefault, macRoutine_c, null, new_cfhandles_cf, ostypes.TYPE.UInt64(ostypes.CONST.kFSEventStreamEventIdSinceNow), 0, ostypes.CONST.kFSEventStreamCreateFlagWatchRoot | ostypes.CONST.kFSEventStreamCreateFlagFileEvents | ostypes.CONST.kFSEventStreamCreateFlagNoDefer);
		console.log('new_stream:', new_stream);
		if (new_stream.isNull()) { // i have seen this null when new_cfhandles_cf had no paths added to it, so was an empty aNewCfHandles/new_cfhandles_c
			console.error('Failed FSEventStreamCreate!! Aborting as in not re-starting poll');

			// clean up new_'s
			ostypes.API('CFRelease')(new_cfhandles_cf);
			new_cfhandles_cf = null;
			new_cfhandles_c = null;

			// return
			rez = undefined;
		} else {

			// schedule it on gRunLoop in default mode for CFrunLoopRun
			ostypes.API('FSEventStreamScheduleWithRunLoop')(new_stream, gRunLoop, ostypes.CONST.kCFRunLoopDefaultMode); // returns void

			// start the stream
			var rez_startstream = ostypes.API('FSEventStreamStart')(new_stream);
			console.log('rez_startstream:', rez_startstream);
			if (!rez_startstream) {
				console.error('Failed FSEventStreamStart! Aborting - as in will not restart poll');

				// clean up new_'s
				macReleaseStream(new_stream, true);
				ostypes.API('CFRelease')(new_cfhandles_cf);
				new_cfhandles_cf = null;
				new_cfhandles_c = null;

				// return
				rez = undefined;
			} else {
				// return
				rez = true;
			}
		}
	}


	if (rez) {
		macReleaseGlobals();

		// update globals
		gCfHandles = aNewCfHandles;
		gCfHandles_c = new_cfhandles_c;
		gCfHandles_cf = new_cfhandles_cf;
		gStream = new_stream;
	};

	return rez;
}

function macRoutine(streamRef, clientCallBackInfo, numEvents, eventPaths, eventFlags, eventIds) {
	console.log('in macRoutine:', 'streamRef:', streamRef, 'clientCallBackInfo:', clientCallBackInfo, 'numEvents:', numEvents, 'eventPaths:', eventPaths, 'eventFlags:', eventFlags, 'eventIds:', eventIds);

	// i need to read the args within this callback, the docs say that at the end of this callback the args are released, so if i had sent this to the mainworker `oshandler` it would read released memory and probably crash
	// the other reason i need to read here is because i dont have a signalid for mac, so i have to figure out the `path` by checking the parent dir of the events
	// TODO: think about how to deal with subdirs, here are some notes:
		// also mac seems to read subdirs, so i want to not alert on subdirs to match behavior of inotify. windows also does read subdirs. but my plan is, if user later adds a subdir, rather then creating a new watch, just dont discard those subdirs
		// IMPORTANT: DO NOT discard subdirs here, send it to mainworker and `oshandler` will determine if should discard subdir

	// js version
	var _numevents = parseInt(cutils.jscGetDeepest(numEvents));

	// these arguments are pointers, lets get the c contents
	var _eventpaths_c = ctypes.cast(eventPaths, ostypes.TYPE.char.ptr.array(_numevents).ptr).contents;
	var _eventflags_c = ctypes.cast(eventFlags, ostypes.TYPE.FSEventStreamEventFlags.array(_numevents).ptr).contents;
	var _eventids_c = ctypes.cast(eventIds, ostypes.TYPE.FSEventStreamEventId.array(_numevents).ptr).contents;

	// lets turn all the c contents, into js arrays with js values
	var _eventpaths = cutils.map( _eventpaths_c, mappers.readString );
	var _eventflags = cutils.map( _eventflags_c, mappers.deepestParseInt );
	var _eventids = cutils.map( _eventids_c, mappers.deepestParseInt );

	console.log('macRoutine args as js:', '_numevents:', _numevents, '_eventids:', _eventids, '_eventflags:', _eventflags, '_eventpaths:', _eventpaths);
}

function andRoutine() {

	// itreate through buf and collect all c events into `_events` as js
	var _events;

	// explanation on the buf size i picked
		// a single `read` can return an array of multiple elements, depending on how many file changes took place
		// i have set up a loop, so it will do `read` until it reads whole buffer
		// SO i can set it to size of 1 struct, however i want to minimize the times called to `read`, so i set max to 10 elements
		// AND I minus `10 * 8` because 8 is the size of `ostypes.TYPE.char.ptr`, which is what is the `inotify_event.name` field size as it is a pointer
		// AND I add `10 * (1 * (NAME_MAX + 1))` because
			// max length of filename is NAME_MAX but the `name` field is null terminated so `+ 1` per the docs here - http://linux.die.net/man/7/inotify
			// 1 * because this is the size of `inotify.name.targetType`
	var buf = ostypes.TYPE.char.array( (10 * ostypes.TYPE.inotify_event.size) - (10 * cutils.typeOfField(ostypes.TYPE.inotify_event, 'name').size) + (10 * (cutils.typeOfField(ostypes.TYPE.inotify_event, 'name').targetType * (ostypes.CONST.NAME_MAX + 1))) )();
	var len = buf.constructor.size;
	while (len === buf.constructor.size) {
		len = ostypes.API('read')(gFd, buf, buf.constructor.size);
		len = parseInt(cutils.jscGetDeepest(len));
		if (len) {
			// make array of the byte array (`buf`) by means of iteration - cannot use `cutils.map` as i need to increment `bytepos_inbuf`
			var events_inbuf = ctypes.cast(buf, ostypes.TYPE.inotify_event.array(eventcnt_inbuf).ptr).contents;
			var bytepos_inbuf = 0;
			while (bytepos_inbuf < len) {
				var _event = {};
				for (var field of ostypes.TYPE.inotify_event.fields) {
					var field_name = Object.keys(field)[0]; // there is only one element
					var field_ctype = field[field_name];

					// set `_event[field_name]`, and in some cases, like for `name` do special `bytepos_inbuf` math
					switch (field_name) {
						case 'wd':
						case 'mask':
						case 'cookie':
						case 'len':
								_event[field_name] = ctypes.cast(buf.addressOfElement(bytepos_inbuf), field_ctype.ptr).contents;
								_event[field_name] = parseInt(cutils.jscGetDeepest(_event[field_name]));
							break;
						case 'name':
								_event[field_name] = ctypes.cast(buf.addressOfElement(bytepos_inbuf), field_ctype.targetType.array(_event.len).ptr).contents;
								_event[field_name] = _event[field_name].readString();

								bytepos_inbuf -= field_ctype.size; // to undo link38377
								bytepos_inbuf += _event.len; // `_event` will for sure have `len` field because in the struct `inotify_event` the `len` field comes before `name` field
							break;
					}

					bytepos_inbuf += field_ctype.size; // link38377
				}

				_events.push(_event);
			}
		}
	}

	// act on events
	var event_count = _events.length;
	console.log('_events:', _events, 'event_count:', event_count);
	if (event_count) {

	}
	else { console.error('WARNING! no events, thats weird, why would i call andRoutine without having any events/byte-content in gFd') }
};

var mappers = { // for use with cutils.map
	readString: el => el.readString(),
	deepestParseInt: el => parseInt(cutils.jscGetDeepest(el))
};

function winRoutine(dwErrorCode, dwNumberOfBytesTransfered, lpOverlapped) {
	console.log('in winRoutine:', 'dwErrorCode:', dwErrorCode, 'dwNumberOfBytesTransfered:', dwNumberOfBytesTransfered, 'lpOverlapped:', lpOverlapped);

	// get signalid
	var signalid = ctypes.cast(lpOverlapped.contents.hEvent, ctypes.uint16_t.ptr).contents;
	console.log('signalid:', signalid);

	// get watcher_entry and path_entry
	var path_info = dwGetActiveInfo(signalid);
	if (!path_info) {
		console.error('what on earth? this should never happen! no path_info for signalid! this is bad!! aborting all watching in this worker');
		throw new Error('what on earth? this should never happen! no path_info for signalid! this is bad!! aborting all watching in this worker');
	}

	var {entry:path_entry, path} = path_info;
	// console.log('path:', path);

	if (cutils.jscEqual(dwErrorCode, 0)) {
		// ok no error, so a file change happened

		// get notif_buf
		var notif_buf = path_entry.notif_buf;

		// inform mainworker oshandler
		callInMainworker('dwCallOsHandlerById', {
			path,
			rest_args: [dwNumberOfBytesTransfered, cutils.strOfPtr(notif_buf.address())]
		});

		var new_notif_buf = ostypes.TYPE.DWORD.array(NOTIFICATION_DWORD_BUFFER_LENGTH)(); // must use new notif_buf to avoid race conditions per - "However, you have to make sure that you use a different buffer than your current call or you will end up with a race condition." - https://qualapps.blogspot.com/2010/05/understanding-readdirectorychangesw_19.html
		path_entry.notif_buf = new_notif_buf;

		// retrigger ReadDirectoryChanges on this hdir, otherwise WaitForMultipleObjectsEx will return immediately with index of this hdir in gLpHandles
		var rez_rdc = ostypes.API('ReadDirectoryChanges')(path_entry.hdir, path_entry.notif_buf.address(), NOTIFICATION_BUFFER_SIZE_IN_BYTES, false, DW_NOTIFY_FILTER, null, path_entry.o.address(), winRoutine_c);
		console.log('rez_rdc:', rez_rdc);

		if (!rez_rdc) {
			// failed to re-watch
			console.error('ABORTING DUE TO UNEXPECTED ERROR!! failed to re-watch due to error:', ctypes.winLastError);
		} else {
			startPoll();
		}
	} else if (cutils.jscEqual(dwErrorCode, ostypes.CONST.ERROR_OPERATION_ABORTED)) {
		// this one was canceled via CancelIo so lets release the handle
		console.log('in callback - CANCELLED via CancelIo');

		var { hdir } = path_entry;

		// close handle
		var rez_closehandle = ostypes.API('CloseHandle')(hdir);
		console.log('rez_closehandle:', rez_closehandle);

		// remove from active paths as it was succesully unwatched
		delete gDWActive[path];

		if (!rez_closehandle) {
			// if fail here, it should be ok, its just bad for memory
			console.error('failed to closehandle on path:', aPath, 'due to error:', ctypes.winLastError);
			path_entry.removed = true;
		} else {
			// succesfully removed path
			path_entry.removed = true;
		}
	} else {
		console.error('UNKNOWN ERROR!!!! dwErrorCode:', dwErrorCode);
	}
}

var gStartPollTimeout;
function startPoll(aMilliseconds=0) {
	clearTimeout(gStartPollTimeout);
	if (Object.keys(gDWActive).length) {
		gStartPollTimeout = setTimeout(poll, aMilliseconds);
	}
}

function dwGetActiveInfo(aBy) {
	// aBy
		// string - path - platform path of directory watched
		// int - signalid

	// returns
		// undefined if not found
		// `{path, entry}` where `entry` in `gDWActive` by reference

	if (typeof(aBy) == 'string') {
		if (!gDWActive[aBy]) {
			return undefined;
		} else {
			return { path:aBy, entry:gDWActive[aBy] };
		}
	} else {
		for (var path in gDWActive) {
			var path_entry = gDWActive[path];
			if (path_entry.signalid === aBy) {
				return { path, entry:path_entry };
			}
		}
	}
}

// start - common helper functions
function Deferred() {
	this.resolve = null;
	this.reject = null;
	this.promise = new Promise(function(resolve, reject) {
		this.resolve = resolve;
		this.reject = reject;
	}.bind(this));
	Object.freeze(this);
}
function genericReject(aPromiseName, aPromiseToReject, aReason) {
	var rejObj = {
		name: aPromiseName,
		aReason: aReason
	};
	console.error('Rejected - ' + aPromiseName + ' - ', rejObj);
	if (aPromiseToReject) {
		aPromiseToReject.reject(rejObj);
	}
}
function genericCatch(aPromiseName, aPromiseToReject, aCaught) {
	var rejObj = {
		name: aPromiseName,
		aCaught: aCaught
	};
	console.error('Caught - ' + aPromiseName + ' - ', rejObj);
	if (aPromiseToReject) {
		aPromiseToReject.reject(rejObj);
	}
}
// end - common helper functions
