
const spawn = require('child_process').spawn;
const fs = require('fs');
const tcpportused = require('tcp-port-used');
const os = require('os'); 
const path = require('path');
const process = require('process');
const find = require('find');

//load config from local directory
const config = require(process.cwd()+'/config.json');

//statis config for now..
const minport=11000;
const maxport=11100;

console.log("starting setup");
console.dir(config);

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
    html: "nginx",
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
        console.log("container started. const_id:",cont_id);
        fs.writeFileSync("cont.id", cont_id);
        cb(null, cont_id);
    });
}

const pull = spawn('docker', ['pull', container_name]); 
pull.stdout.on('data', (data)=>{
    console.log(data.toString());
});
pull.stderr.on('data', (data)=>{
    console.error(data.toString());
});

pull.on('close', (code)=>{
    if(code != 0) throw new Error("failed to pull container. code:"+ code);
    
    //create password for vncserver
    require('crypto').randomBytes(8, function(err, buffer) {
        const password = buffer.toString('hex');

        let opts = ['run', '-d'];
        if(config.type == "html") {
            //find the first .html file under abs_src_path
            find.file(/.html$/, abs_src_path, files=>{
                //find does DFS. so pick the last one
                let index = files[files.length-1];
                //strip the abs_src_path
                index = index.substring(abs_src_path.length+1); //remove the trailing / also
                console.log("using index", index);
                
                //nginx container
                console.log("looking for an open port");
                tcpportused.findFree(11000, 12000, '0.0.0.0').then(port=>{
                    console.log("going to use ", port);
                    opts = opts.concat(['-v', abs_src_path+':/usr/share/nginx/html/'+password+':ro']);
                    opts = opts.concat(['-p', "0.0.0.0:"+port+":80"]);
                    startContainer(container_name, opts, (err, cont_id)=>{
                        console.log("waiting for nginx to start", port);
                        tcpportused.waitUntilUsed(port, 200, 9000).then(()=>{
                            var url = "https://"+os.hostname()+"/vnc/"+port+"/"+password+"/"+index;
                            console.log("started", url);
                            fs.writeFileSync("url.txt", url);
                        });
                    });
                });
            });
        } else {
            //NOVNC container
            opts = opts.concat(['--publish-all']);
            opts = opts.concat(['--gpus', 'all']);
            opts = opts.concat(['-e', 'INPUT_DIR='+input_dir]);
            opts = opts.concat(['-e', 'X11VNC_PASSWORD='+password]);
            opts = opts.concat(['-e', 'LD_LIBRARY_PATH=/usr/lib/host']);
            opts = opts.concat(['-v', input_inst_dir+':/input-instance:ro']);
            opts = opts.concat(['-v', abs_src_path+':/input:ro']);//deprecated.. use /input-instance
            opts = opts.concat(['-v', '/tmp/.X11-unix:/tmp/.X11-unix:ro']);
            opts = opts.concat(['-v', process.cwd()+'/lib:/usr/lib/host:ro']);
            opts = opts.concat(['-v', '/usr/local/licensed-bin:/usr/local/licensed-bin:ro']);
            startContainer(container_name, opts, (err, cont_id)=>{
                getDockerPort(cont_id, (err, vncport)=>{
                    if(err) throw err;
                    
                    //wait for vnc server to become ready
                    console.log("waiting for container.vncserver", vncport);
                    tcpportused.waitUntilUsed(vncport, 200, 9000) //port, retry, timeout
                    .then(()=>{
                    
                        //find open port to use for noVNC to expose the vncport
                        tcpportused.findFree(11000, 12000, '0.0.0.0').then(port=>{
                            
                            //start noVNC
                            const novnc_out = fs.openSync('./novnc.log', 'a');
                            const novnc_err = fs.openSync('./novnc.log', 'a');
                            console.log('running /usr/local/noVNC/utils/launch.sh', '--listen', port, '--vnc', "0.0.0.0:"+vncport);
                            const novnc = spawn('/usr/local/noVNC/utils/launch.sh', ['--listen', port, '--vnc', "0.0.0.0:"+vncport], {
                                detached: true, stdio: ['ignore', novnc_out, novnc_err]
                            });
                            novnc.unref();

                            tcpportused.waitUntilUsed(port, 200, 10*1000) //port, retry, timeout
                            .then(()=>{
                                console.log("started novnc", novnc.pid);
                                fs.writeFileSync("novnc.pid", novnc.pid);
                                var url = "https://"+os.hostname()+"/vnc/"+port+"/vnc_lite.html?path=vnc/"+port+"/websockify&password="+password+"&reconnect=true&title="+config.title||"brainlife";
                                fs.writeFileSync("url.txt", url);
                                console.log("all done", url);
                            }, err=>{
                                console.error("noNVC didn't start in 10sec");
                    throw err;
                            });
                        }, err=>{
                            console.error("can't find an open port for novnc");
                            throw err;
                        });
                    }, err=>{
                        console.error("contianer.vncserver didn't become ready in 9sec");
                        throw err;
                    });
                });
            });
        }
    });
});


