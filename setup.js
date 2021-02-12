
const spawn = require('child_process').spawn;
const fs = require('fs');
const tcpportused = require('tcp-port-used');
const os = require('os'); 
const path = require('path');
const process = require('process');
const find = require('find');
const async = require('async');

const minport=11000;
const maxport=11200;

//load config from local directory
const config = require(process.cwd()+'/config.json');

console.log("starting setup");

//start docker container
var src_path = '../../'+config.input_instance_id+'/'+config.input_task_id;
if(config.subdir) src_path += '/'+config.subdir;
var abs_src_path = path.resolve(src_path);

let input_dir = "/input-instance/"+config.input_task_id;
if(config.subdir) input_dir += '/'+config.subdir;

let input_inst_dir = path.resolve(process.cwd()+"/../../"+config.input_instance_id);

const mappings = {
    fibernavigator: "soichih/vncserver-fibernavigator",
    conn: "soichih/ui-conn",
    trackvis: "brainlife/ui-trackvis",
    wb_view: "brainlife/ui-wb_view",
    fslview: "soichih/vncserver-fslview:17",
    fsleyes: "brainlife/ui-fsleyes:2.0",
    mricrogl: "soichih/vncserver-mricrogl:1.3",
    "freeview-gpu": "soichih/vncserver-freeview-gpu:2.1",
    mrview: "soichih/vncserver-mrview:4.2",
    //html: "nginx:1.16.1", //last version that didn't change uid to 101
    html: "brainlife/nginx:1.0",
    dsistudio: "brainlife/ui-dsistudio:1.0",
    itksnap: "brainlife/ui-itksnap:5.0.9",
    brainstorm: "brainlife/ui-brainstorm:210128",
}

const container_name = mappings[config.type];
if(!container_name) {
    console.error("unknown container type", config.type);
    process.exit(1);
}

//use docker port command to find out which host:port the container is using
function getDockerPort(id, cb) {
    //find host:port that container listens to
    const getp = spawn('docker', ['port', id]);
    var rep = "";
    var err = "";
    getp.stdout.on('data', (data)=>{
        rep += data.toString().trim();
    });
    getp.stderr.on('data', (data)=>{
        err += data.toString().trim();
    });
    getp.on('close', (code)=>{
        if(code != 0) return cb(err);
        //rep> 5900/tcp -> 0.0.0.0:32780
        var hostport = rep.split(" ")[2]; //0.0.0.0:32780
        var port = parseInt(hostport.split(":")[1]); //32780
        cb(null, port);
    });
}

function startContainer(name, opts, cb) {
    console.log("starting", name, "with", opts);

    let cont_id = "";
    let err = "";
    const cont = spawn('docker', [...opts, name]); 
    cont.stdout.on('data', (data)=>{
        cont_id+=data.toString().trim();
    });
    cont.stderr.on('data', (data)=>{
        err += data.toString();
    });
    cont.on('close', (code)=>{
        if(code != 0) return cb("failed to start container. code:"+ code);
        fs.writeFileSync("cont.id", cont_id);
        cb(null, cont_id);
    });
}

function dockerPull(container_name, cb) {
	const pull = spawn('docker', ['pull', container_name]); 
	pull.stdout.on('data', data=>{
	    console.log(data.toString());
	});
	pull.stderr.on('data', data=>{
	    console.error(data.toString());
	});
	pull.on('close', code=>{
	    if(code != 0) return cb("failed to pull container. code:"+ code);
        cb();
	});
}

let password;
let port; //novnc or nginx port between 11000 - 12000

async.series([
    next=>{
        console.log("docker pulling container:", container_name);
        dockerPull(container_name, next);
    },

    next=>{
        console.log("creating vncserver password");
        require('crypto').randomBytes(8, (err, buffer)=>{
            password = buffer.toString('hex');
            next();
        });
    },

    next=>{
        console.log("looking for an open port");
        tcpportused.findFree(minport, maxport, '0.0.0.0').then(_port=>{
            port = _port;
            console.log("going to use ", port);
            next();
        });
    },

    next=>{
        //do container specific things.
        if(config.type == "html") startNginx(next);
        else startNOVNC(next);
    },

], err=>{
    if(err) throw err;
    console.log("all done");
});

function startNginx(cb) {

    let index_html;
    async.series([
        //find the first .html file under abs_src_path
        next=>{
            find.file(/.html$/, abs_src_path, files=>{
                //find does DFS. so pick the last one and strip the abs_src_path (remove the trailing / also)
                index_html = files[files.length-1].substring(abs_src_path.length+1); 
                next();
            });
        },

        next=>{
            console.log("starting nginx container");
            let opts = ['run', '-d'];
            opts = opts.concat(['-v', abs_src_path+':/usr/share/nginx/html/'+password+':ro']);
            opts = opts.concat(['-p', "0.0.0.0:"+port+":80"]);
            startContainer(container_name, opts, next);
        },

        next=>{
            let url = "https://"+os.hostname()+"/vnc/"+port+"/"+password+"/"+index_html;
            console.debug(url);
            console.log("waiting for nginx to start on", port);
            tcpportused.waitUntilUsed(port, 200, 9000) //port, retry, timeout
            .then(()=>{
                fs.writeFileSync("url.txt", url);
                next();
            }).catch(next);
        },

    ], cb);
}

function startNOVNC(cb) {
    let vncPort;
    let gpus; //list of gpu bus IDs
    async.series([
        
        //list number of available gpus
        next=>{
            //nvidia-smi --query-gpu=gpu_bus_id --format=csv,noheader
            let out = "";
            const smi = spawn('nvidia-smi', ['--query-gpu=gpu_bus_id', '--format=csv,noheader']);
            smi.stdout.on('data', data=>{
                out += data.toString();
            });
            smi.stderr.on('data', data=>{
                console.error(data.toString());
            });
            smi.on('close', code=>{
                if(code != 0) return next("failed to query gpus");
                gpus = out.trim().split("\n");
                next();
            });
        },
        
        next=>{
            console.log("starting ui container");

            //decide on VGL_DISPLAY to use
            let dindex = Math.floor(Math.random()*gpus.length);
            let display = [":0.0", ":0.1"][dindex];
            
            let opts = ['run', '-d'];
            opts = opts.concat(['--publish-all']);
            opts = opts.concat(['--gpus', 'all']);
            opts = opts.concat(['-e', 'INPUT_DIR='+input_dir]);
            opts = opts.concat(['-e', 'VGL_DISPLAY='+display]);
            opts = opts.concat(['-e', 'X11VNC_PASSWORD='+password]);
            opts = opts.concat(['-e', 'LD_LIBRARY_PATH=/usr/lib/host']);
            opts = opts.concat(['-v', input_inst_dir+':/input-instance:ro']);
            opts = opts.concat(['-v', abs_src_path+':/input:ro']);//deprecated.. use /input-instance
            opts = opts.concat(['-v', '/tmp/.X11-unix:/tmp/.X11-unix:ro']);
            opts = opts.concat(['-v', process.cwd()+'/lib:/usr/lib/host:ro']);
            opts = opts.concat(['-v', '/usr/local/licensed-bin:/usr/local/licensed-bin:ro']);
            startContainer(container_name, opts, (err, cont_id)=>{
                if(err) return next(err);
                //find out which vncport it's using
                getDockerPort(cont_id, (err, _vncPort)=>{
                    if(err) return next(err);
                    vncPort = _vncPort;
                    console.log("container started", cont_id, "port", vncPort);
                    next();
                });
            });
        },

        next=>{
            console.log("waiting for container.vncserver", vncPort);
            tcpportused.waitUntilUsed(vncPort, 200, 9000) //port, retry, timeout
            .then(()=>{
                console.log("vncserver is ready!");
                next();
            });
        },

        next=>{
            console.log('running /usr/local/noVNC/utils/launch.sh', '--listen', port, '--vnc', "0.0.0.0:"+vncPort);
            const novnc_out = fs.openSync('./novnc.log', 'a');
            const novnc_err = fs.openSync('./novnc.log', 'a');
            const novnc = spawn('/usr/local/noVNC/utils/launch.sh', ['--listen', port, '--vnc', "0.0.0.0:"+vncPort], {
                detached: true, stdio: ['ignore', novnc_out, novnc_err]
            });
            novnc.unref();
            fs.writeFileSync("novnc.pid", novnc.pid.toString());
            fs.writeFileSync("novnc.pid", novnc.pid.toString());
            next();
        },

        next=>{
            let url = "https://"+os.hostname()+"/vnc/"+port+"/vnc_lite.html?path=vnc/"+port+"/websockify&password="+password+"&reconnect=true&title="+config.title||"brainlife";
            console.log("waiting for novnc to become ready", url);
            tcpportused.waitUntilUsed(port, 200, 9000) //port, retry, timeout
            .then(()=>{
                console.log("started novnc");
                fs.writeFileSync("url.txt", url);
                next();
            }).catch(next);
         },

    ], cb);
}


