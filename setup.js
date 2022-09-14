const spawn = require('child_process').spawn;
const fs = require('fs');
const tcpportused = require('tcp-port-used');
const os = require('os'); 
const path = require('path');
const process = require('process');
const async = require('async');

//where we are going to start novnc
let docker_hostname = "0.0.0.0";
const minport = 11000;
const maxport = 11200;

function findFree(min_port, max_port, host="0.0.0.0") {
    return new Promise((resolve, reject)=>{

        //create a list of ports
        var ports = [];
        for(var p = min_port; p <= max_port; ++p) ports.push(p);

        //then itereate
        async.eachSeries(ports, (p, next)=>{
            tcpportused.check(p, host).then(inuse=>{
                if(inuse) next();
                else resolve(p);
            }, next);
        }, (err)=>{
            if(err) reject(err);
            else reject(new Error("Couldn't find an open port"));
        });
    });
}

//load config from local directory
const config = require('./config.json');

console.log("starting setup");

//TODO - these path findings can be simplified if start by figuring out the workdir path
//then override that with BRAINLIFE_HOST_SCRATCH, then contatenate various inst/task dirs

let inst_path = '../../'+config.input_instance_id;
let input_dir = "/input-instance/"+config.input_task_id;
let src_path = inst_path+'/'+config.input_task_id;
let urlbase = "https://"+os.hostname();
if(config.subdir) {
    input_dir += '/'+config.subdir;
    src_path += '/'+config.subdir;
}

//resolve to absolute path
let abs_task_dir = path.resolve(".");
let abs_inst_dir = path.resolve(inst_path);
let abs_src_path = path.resolve(src_path);

//on local dev environment, vis server container is run on the host
//the volume src inside container is actually the paths on the host machine.
//we need to specify the host path to access the scratch volume mounted inside the
//container for it to be able to access it
if(process.env.BRAINLIFE_HOSTSCRATCH) {
    //grab inst/task dir from cwd
    const tokens = process.cwd().split("/");
    const insttask = tokens.slice(-2).join("/");
    abs_task_dir = process.env.BRAINLIFE_HOSTSCRATCH+"/"+insttask;
    abs_inst_dir = process.env.BRAINLIFE_HOSTSCRATCH+"/"+config.input_instance_id;
    abs_src_path = abs_inst_dir+"/"+config.input_task_id;
    if(config.subdir) abs_src_path += "/"+config.subdir;

    //point it to the localhost (TODO - port might not be 8080?)
    urlbase = "http://localhost:8080";
    //we use docker engine on the host, so what's where we need to reach to find out
    //if are running things
    docker_hostname = "host.docker.internal";
}

console.log(`input_dir ${input_dir}`);
console.log(`abs_src_path ${abs_src_path}`);
console.log(`abs_inst_dir ${abs_inst_dir}`);
console.log(`abs_task_dir ${abs_task_dir}`);

const mappings = {
    //nonvc apps
    fibernavigator: "soichih/vncserver-fibernavigator",
    conn: "soichih/ui-conn",
    trackvis: "brainlife/ui-trackvis",
    wb_view: "brainlife/ui-wb_view",
    fslview: "soichih/vncserver-fslview:18",
    fsleyes: "brainlife/ui-fsleyes:2.0",
    mricrogl: "soichih/vncserver-mricrogl:1.3",
    "freeview-gpu": "soichih/vncserver-freeview-gpu:2.1",
    mrview: "soichih/vncserver-mrview:4.2",
    dsistudio: "brainlife/ui-dsistudio:1.0",
    itksnap: "brainlife/ui-itksnap:5.0.9",
    brainstorm: "brainlife/ui-brainstorm:210128",

    //web apps
    //html: "nginx:1.16.1", //last version that didn't change uid to 101
    html: "brainlife/nginx:1.0",
    mnefif: "brainlife/ui-mne:0.22.1",
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
    let rep = "";
    let err = "";
    getp.stdout.on('data', (data)=>{
        rep += data.toString();
    });
    getp.stderr.on('data', (data)=>{
        err += data.toString();
    });
    getp.on('close', (code)=>{
        if(code != 0) return cb(err);

        //sometime obtaining port fails.. this is for future debugging
        console.debug(rep);
        console.error(err);

        const first = rep.split("\n")[0]; //grab the first line
        let hostport = first.split(" ")[2]; //grab the 3rd token "0.0.0.0:49163"
        let port = parseInt(hostport.split(":")[1]); //32780

        cb(null, port);
    });
}

function startContainer(name, opts, cb) {
    console.log("starting", name);
    console.debug(['docker', ...opts, name].join(" "));

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
        findFree(minport, maxport).then(_port=>{
            port = _port;
            console.log("going to use ", port);
            next();
        });
    },

    next=>{
        //do container specific things.
        if(config.type == "html") startNginx(next);
        else if(config.type == "mnefif") startWeb(next);
        else startNOVNC(next);
    },

], err=>{
    if(err) throw err;
    console.log("all done");
});

function startNginx(cb) {

    async.series([

        //if index_html is not specified, find the first .html file under abs_src_path
        next=>{
            console.log("finding *.html in ", abs_src_path);
            const pull = spawn('find', [abs_src_path, '-name', '*.html']);
            let out = "";
            pull.stdout.on('data', data=>{
                out += data.toString();
            });
            pull.stderr.on('data', data=>{
                console.error(data.toString());
            });
            pull.on('close', code=>{
                if(code != 0) return next("failed to find index.html"+ code);

                //pick the last one on the list
                const files = out.trim().split("\n");

                //sort by depth
                files.sort((a,b)=>{
                    const ad = a.split("/").length;
                    const bd = b.split("/").length;
                    return bd - ad;
                });
                console.dir(files);

                if(files.length) {
                    const lastfile = files.pop();
                    console.log("laastfile found", lastfile);
                    index_html = lastfile.substring(abs_src_path.length+1);
                }
                next();
            });
        },

        next=>{
            console.log("starting nginx container");
            let opts = ['run', '-d'];
            opts = opts.concat(['-v', abs_src_path+':/usr/share/nginx/html/'+password+':ro']);
            opts = opts.concat(['-e', 'INPUT_DIR='+input_dir]);
            opts = opts.concat(['-p', "0.0.0.0:"+port+":80"]);
            startContainer(container_name, opts, next);
        },

        next=>{
            const url = urlbase+"/vnc/"+port+"/"+password+"/"+index_html;
            console.debug(url);
            console.log("waiting for web server to start on", port);
            tcpportused.waitUntilUsed(port, 200, 9000) //port, retry, timeout
            .then(()=>{
                fs.writeFileSync("url.txt", url);
                next();
            }).catch(next);
        },

    ], cb);
}

function startWeb(cb) {

    async.series([
        next=>{
            console.log("starting webserver container");
            let opts = ['run', '-d'];

            //for Jupyter notebook
            opts = opts.concat(['-v', abs_inst_dir+':/input-instance:ro']);
            opts = opts.concat(['-e', 'INPUT_DIR='+input_dir]);

            //TODO - can't get it work through nginx .. so we don't need this at the moment.. but
            //klet's set it for now for future
            opts = opts.concat(['-e', 'BASEURL=/vnc/'+port+'/'+password+'/']); //need trailling /

            opts = opts.concat(['-p', "0.0.0.0:"+port+":80"]);
            startContainer(container_name, opts, next);
        },

        next=>{
            //notebook to open first
            const index_html = "notebooks/main.ipynb";

            //does urlbase need to be http?
            const url = urlbase+":"+port+"/vnc/"+port+"/"+password+'/'+index_html;

            console.debug("-----------------------------");
            console.debug(url);
            console.debug("-----------------------------");

            console.log("waiting for web server to start on", port);
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
    let gpus = []; //list of gpu bus IDs
    async.series([

        //list number of available gpus
        next=>{
            //nvidia-smi --query-gpu=gpu_bus_id --format=csv,noheader
            const smi = spawn('nvidia-smi', ['--query-gpu=gpu_bus_id', '--format=csv,noheader']);
            let out = "";
            smi.stdout.on('data', data=>{
                out += data.toString();
            });
            smi.stderr.on('data', data=>{
                console.error(data.toString());
            });
            smi.on('close', code=>{
                if(code != 0) {
                    console.error("failed to run nvidia-smi");
                    return next();
                }
                gpus = out.trim().split("\n");
                next();
            });

            //without this ENOENT exception is thrown
            smi.on('error', err=>{
                console.log("ale?");
            });
        },

        next=>{
            console.log("starting ui container");

            let opts = ['run', '-d'];
            opts = opts.concat(['--publish-all']);
            opts = opts.concat(['-e', 'INPUT_DIR='+input_dir]);
            opts = opts.concat(['-e', 'X11VNC_PASSWORD='+password]);
            opts = opts.concat(['-v', '/tmp/.X11-unix:/tmp/.X11-unix:ro']);
            opts = opts.concat(['-e', 'LD_LIBRARY_PATH=/usr/lib/host']);
            opts = opts.concat(['-v', '/usr/local/licensed-bin:/usr/local/licensed-bin:ro']);
            opts = opts.concat(['-v', abs_inst_dir+':/input-instance:ro']);
            opts = opts.concat(['-v', abs_src_path+':/input:ro']);//deprecated.. use /input-instance
            opts = opts.concat(['-v', abs_task_dir+'/lib:/usr/lib/host:ro']);

            if(gpus.length) {
                //decide on VGL_DISPLAY to use
                let dindex = Math.floor(Math.random()*gpus.length);
                let display = [":0.0", ":0.1"][dindex];

                //:0.0 is too slow on gpu2 for some reason.. it's stuck on P8 (powerstate).. but gpu1 is like that
                //and it's not too slow..
                if(urlbase == "https://gpu2-pestillilab.psych.indiana.edu") display = ":0.0";

                opts = opts.concat(['--gpus', 'all']);
                opts = opts.concat(['-e', 'VGL_DISPLAY='+display]);
            }

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
            tcpportused.waitUntilUsedOnHost(vncPort, docker_hostname, 200, 9000) //port, retry, timeout
            .then(()=>{
                console.log("vncserver is ready!");
                next();
            });
        },

        next=>{
            const novnc_out = fs.openSync('./novnc.log', 'a');
            const novnc_err = fs.openSync('./novnc.log', 'a');
            const novnc = spawn('/usr/local/noVNC/utils/novnc_proxy', ['--listen', port, '--vnc', docker_hostname+":"+vncPort], {
                detached: true, stdio: ['ignore', novnc_out, novnc_err]
            });
            novnc.unref();
            fs.writeFileSync("novnc.pid", novnc.pid.toString());
            fs.writeFileSync("novnc.pid", novnc.pid.toString());
            next();
        },

        next=>{
            let url = urlbase+"/vnc/"+port+"/vnc_lite.html?path=vnc/"+port+"/websockify&password="+password+"&reconnect=true&title="+config.title||"brainlife";
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

