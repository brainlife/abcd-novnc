
const spawn = require('child_process').spawn;
const fs = require('fs');
const tcpportused = require('tcp-port-used');
const os = require('os'); 
const path = require('path');

//load config from local directory
const config = require(process.cwd()+'/config.json');

//statis config for now..
const minport=11000;
const maxport=12000;

console.log("starting setup");
console.dir(config);

console.log("starting container");

//start docker container
//TODO validate config.input_instance_id
//TODO validate config.input_task_id
//TODO validate config.type
//const cont = spawn('docker', ['run', '-dP', '-v', process.env.INST_DIR+'/'+config.input_task_id+':/input:ro', config.container]); 
var src_path = '../../'+config.input_instance_id+'/'+config.input_task_id;
var abs_src_path = path.resolve(src_path);

switch(config.type) {
case "fslview":
    var container_name = "soichih/vncserver-fsl"; break;
case "freeview":
    var container_name = "soichih/vncserver-freeview"; break;
case "mrview":
    var container_name = "soichih/vncserver-mrview"; break;
}

console.log('docker', ['run', '-dP', '-v', abs_src_path+':/input:ro', container_name]); 
const cont = spawn('docker', ['run', '-dP', '-v', abs_src_path+':/input:ro', config.container]); 
var cont_id = "";
cont.stdout.on('data', (data)=>{
    cont_id+=data.toString().trim();
});
cont.stderr.on('data', (data)=>{
    console.error(data.toString());
});
cont.on('close', (code)=>{
    if(code != 0) throw new Error("failed to start container. code:"+ code);
    console.log("container started",cont_id);

    fs.writeFileSync("cont.id", cont_id);

    //find host:port that container listens to
    const getp = spawn('docker', ['port', cont_id]);
    var rep = "";
    getp.stdout.on('data', (data)=>{
        rep += data.toString().trim();
    });
    getp.stderr.on('data', (data)=>{
        console.error(data.toString());
    });
    getp.on('close', (code)=>{
        if(code != 0) throw new Error("failed to get docker host/port");
        var hostport = rep.split(" ")[2];
        console.log("container listening on ", hostport);
        
        //set password for vncserver
        require('crypto').randomBytes(4, function(err, buffer) {
            const token = buffer.toString('hex');
            //console.log('docker', ['exec', cont_id, 'bash', '-c', "echo -e '"+token+"\n"+token+"\nn' | vncpasswd"]); 
            const setpass = spawn('docker', ['exec', cont_id, 'bash', '-c', "echo -e '"+token+"\n"+token+"\nn' | vncpasswd"]); 
            setpass.stderr.on('data', (data)=>{
                console.error(data.toString());
            });
            setpass.on('close', (code)=>{
                if(code != 0) throw new Error("failed to set password for vncserver");

                //find open port to use
                tcpportused.findFree(11000, 12000, '0.0.0.0')
                .then(function(port) {
                    //start noVNC
                    const novnc_out = fs.openSync('./novnc.log', 'a');
                    const novnc_err = fs.openSync('./novnc.log', 'a');
                    console.log('/usr/local/noVNC/utils/launch.sh', '--listen', port, '--vnc', hostport);
                    const novnc = spawn('/usr/local/noVNC/utils/launch.sh', ['--listen', port, '--vnc', hostport], {
                        detached: true, stdio: ['ignore', novnc_out, novnc_err]
                    });
                    novnc.unref();

                    console.log("started novnc", novnc.pid);
                    fs.writeFileSync("novnc.pid", novnc.pid);

                    var url = "http://"+os.hostname()+":"+port+"/vnc_auto.html?password="+token;
                    fs.writeFileSync("url.txt", url);
                    console.log("all done", url);
                }, function(err) {
                    console.log("throwing now");
                    throw err;
                });
            });
        });
    });

});
